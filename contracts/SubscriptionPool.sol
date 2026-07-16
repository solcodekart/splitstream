// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {IArbitrator, IArbitrable} from "./interfaces/IArbitrator.sol";

/// @title SubscriptionPool
/// @notice One shared family-plan pool. An `owner` provides a real off-chain
///         subscription and adds members to it. Members stream a stablecoin to
///         the owner from a prepaid buffer. The owner can only *withdraw*
///         streamed funds for a member while that member holds a fresh
///         proof-of-access (zkTLS) — so payment is gated on delivery. Both sides
///         post bonds; disputes go to a decentralised arbitrator (Kleros-style).
///
/// @dev    The internal buffer→pending streaming models a Superfluid-style
///         continuous flow in a self-contained, testable way. In production the
///         flow accounting can be delegated to Superfluid CFAs; the proof-gating,
///         bonding and dispute logic stays the same.
contract SubscriptionPool is IArbitrable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ----------------------------------------------------------------------
    // Config (immutable after construction)
    // ----------------------------------------------------------------------
    IERC20 public immutable token;          // stablecoin used for payment & bonds
    address public immutable owner;          // subscription provider
    uint256 public immutable seatPrice;      // cost per seat per cycle
    uint256 public immutable cycleDuration;  // seconds per billing cycle (e.g. 30 days)
    uint256 public immutable seatCount;      // max members
    uint256 public immutable ownerBondRequired;
    uint256 public immutable memberBondRequired;
    uint256 public immutable proofValidity;  // max age of an access proof for owner to claim
    uint256 public immutable reminderWindow; // runway (s) below which a top-up reminder fires
    uint256 public immutable slashAmount;    // owner bond slashed to member on member-win dispute
    bytes32 public immutable subscriptionRef;// opaque ref to the off-chain plan
    IProofVerifier public immutable proofVerifier;
    IArbitrator public immutable arbitrator;
    string public metadata;                  // e.g. "Spotify Family - EU"

    // ----------------------------------------------------------------------
    // State
    // ----------------------------------------------------------------------
    bool public active;            // true once owner bond funded
    uint256 public ownerBondBalance;
    uint256 public seatsTaken;
    uint256 public openDisputes;   // count of raised-but-unruled disputes (locks owner bond)

    struct Member {
        uint256 buffer;       // prepaid, not-yet-streamed balance
        uint256 pending;      // streamed, awaiting proof-gated owner claim
        uint256 bond;         // member's posted bond
        uint256 lastSettled;  // last time the stream was accounted
        uint256 lastProof;    // timestamp of last valid access proof
        bool joined;          // has ever joined
        bool isActive;        // currently holds a seat
        bool inDispute;       // funds frozen pending arbitration
        bool slashed;         // owner bond has already been slashed to this member once
    }

    mapping(address => Member) public members;
    mapping(uint256 => address) public disputeToMember; // arbitrator disputeId -> member
    mapping(address => uint256) public withdrawable;     // pull-payment ledger

    // ----------------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------------
    event PoolActivated(uint256 ownerBond);
    event Joined(address indexed member, uint256 buffer, uint256 bond);
    event ToppedUp(address indexed member, uint256 amount, uint256 newBuffer);
    event Settled(address indexed member, uint256 streamed, uint256 buffer, uint256 pending);
    event ReminderDue(address indexed member, uint256 runwaySeconds);
    event Excluded(address indexed member);
    event AccessProven(address indexed member, uint256 at);
    event OwnerClaimed(address indexed member, uint256 amount);
    event Exited(address indexed member, uint256 refunded);
    event DisputeRaised(address indexed member, uint256 indexed disputeId);
    event Ruled(address indexed member, uint256 indexed disputeId, uint256 ruling);
    event Withdrawn(address indexed who, uint256 amount);

    // ----------------------------------------------------------------------
    // Errors
    // ----------------------------------------------------------------------
    error NotOwner();
    error NotActive();
    error AlreadyActive();
    error NoSeats();
    error AlreadyMember();
    error NotMember();
    error BufferTooSmall();
    error StaleProof();
    error ReplayedProof();
    error BadProofTime();
    error InDispute();
    error NothingToClaim();
    error NotArbitrator();
    error PendingOutstanding();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _owner,
        IERC20 _token,
        uint256 _seatPrice,
        uint256 _cycleDuration,
        uint256 _seatCount,
        uint256 _ownerBondRequired,
        uint256 _memberBondRequired,
        uint256 _proofValidity,
        uint256 _reminderWindow,
        uint256 _slashAmount,
        bytes32 _subscriptionRef,
        IProofVerifier _proofVerifier,
        IArbitrator _arbitrator,
        string memory _metadata
    ) {
        require(_cycleDuration > 0 && _seatPrice > 0 && _seatCount > 0, "bad params");
        owner = _owner;
        token = _token;
        seatPrice = _seatPrice;
        cycleDuration = _cycleDuration;
        seatCount = _seatCount;
        ownerBondRequired = _ownerBondRequired;
        memberBondRequired = _memberBondRequired;
        proofValidity = _proofValidity;
        reminderWindow = _reminderWindow;
        slashAmount = _slashAmount;
        subscriptionRef = _subscriptionRef;
        proofVerifier = _proofVerifier;
        arbitrator = _arbitrator;
        metadata = _metadata;
    }

    // ----------------------------------------------------------------------
    // Owner lifecycle
    // ----------------------------------------------------------------------

    /// @notice Owner posts their bond, making the pool joinable.
    function fundOwnerBond() external onlyOwner {
        if (active) revert AlreadyActive();
        active = true;
        ownerBondBalance = ownerBondRequired;
        if (ownerBondRequired > 0) {
            token.safeTransferFrom(msg.sender, address(this), ownerBondRequired);
        }
        emit PoolActivated(ownerBondRequired);
    }

    // ----------------------------------------------------------------------
    // Member lifecycle
    // ----------------------------------------------------------------------

    /// @notice Join the pool, depositing an initial buffer plus the member bond.
    /// @param initialBuffer prepaid streaming balance (must cover >= one cycle)
    function join(uint256 initialBuffer) external nonReentrant {
        if (!active) revert NotActive();
        Member storage m = members[msg.sender];
        if (m.isActive) revert AlreadyMember();
        if (seatsTaken >= seatCount) revert NoSeats();
        if (initialBuffer < seatPrice) revert BufferTooSmall();

        // Re-join must start from a clean slate: a member excluded (or exited) while
        // still frozen, or with unclaimed streamed `pending`, cannot re-enter a seat
        // that would mix pre- and post-rejoin accounting or resurrect a stale proof.
        if (m.joined) {
            if (m.inDispute) revert InDispute();
            if (m.pending != 0) revert PendingOutstanding();
            m.lastProof = 0;
        }

        // A re-joining member may still have their original bond posted: exit() is the
        // only path that refunds a bond, so a member who was auto-excluded (buffer
        // exhausted) or had a dispute ruled — but never exited — still has m.bond held
        // by the contract. Charge only the shortfall and reuse the posted bond, rather
        // than overwriting m.bond (which would orphan the prior bond as untracked
        // surplus and double-charge the member).
        uint256 bondDue = memberBondRequired > m.bond ? memberBondRequired - m.bond : 0;

        // Likewise, never blindly overwrite m.buffer: a cleanly-excluded member has
        // buffer==0, but should any residual balance remain, reuse it and charge only
        // the shortfall — overwriting would orphan those funds and break solvency.
        uint256 startBuffer = initialBuffer > m.buffer ? initialBuffer : m.buffer;
        uint256 bufferDue = initialBuffer > m.buffer ? initialBuffer - m.buffer : 0;

        m.buffer = startBuffer;
        m.bond = memberBondRequired;
        m.lastSettled = block.timestamp;
        m.joined = true;
        m.isActive = true;
        seatsTaken += 1;

        token.safeTransferFrom(msg.sender, address(this), bufferDue + bondDue);
        emit Joined(msg.sender, startBuffer, memberBondRequired);
    }

    /// @notice Add funds to your streaming buffer (responding to a reminder).
    function topUp(uint256 amount) external nonReentrant {
        Member storage m = members[msg.sender];
        if (!m.isActive) revert NotMember();
        _settle(msg.sender); // account before changing buffer
        // _settle may have drained the buffer and auto-excluded the member (seat
        // freed, isActive=false). Do NOT credit a top-up to an excluded member: that
        // would leave an inactive member holding buffer outside the seat accounting,
        // and a later join() overwriting m.buffer would orphan those funds (breaking
        // solvency). The member must re-join instead.
        if (!m.isActive) revert NotMember();
        m.buffer += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ToppedUp(msg.sender, amount, m.buffer);
    }

    /// @notice Submit a fresh zkTLS proof that `member` has active access.
    ///         Anyone may submit on a member's behalf (proof is self-authenticating).
    function submitAccessProof(address member, bytes calldata proof) external {
        Member storage m = members[member];
        if (!m.joined) revert NotMember();
        (bool ok, uint256 observedAt) = proofVerifier.verify(member, address(this), subscriptionRef, proof);
        require(ok, "bad proof");
        // Defense-in-depth: every shipped verifier already rejects future-dated proofs, but do
        // not trust that blindly — a broken/future verifier returning observedAt > now would
        // stamp lastProof in the future and make ownerClaim's `now - lastProof` underflow-revert
        // (a claim DoS) until the clock caught up. Reject rather than clamp, so a genuinely
        // future-dated proof can never be laundered into acceptance.
        if (observedAt > block.timestamp) revert BadProofTime();
        // Replay / single-use hardening: stamp freshness from the witness OBSERVATION time,
        // not the submission block, and require each accepted proof to be strictly newer than
        // the last one recorded. This makes a given proof single-use (resubmitting the same
        // observation reverts) and caps a proof's coverage at one `proofValidity` from when
        // access was actually observed — a stale-but-in-window proof can no longer be
        // laundered into a fresh `lastProof` stamp near the edge of its validity.
        if (observedAt <= m.lastProof) revert ReplayedProof();
        m.lastProof = observedAt;
        emit AccessProven(member, observedAt);
    }

    // ----------------------------------------------------------------------
    // Streaming accounting
    // ----------------------------------------------------------------------

    /// @notice Account the stream for `member`: move elapsed cost buffer→pending.
    ///         Permissionless (owner, keeper, or member can poke it).
    function settle(address member) external {
        _settle(member);
    }

    function _settle(address member) internal {
        Member storage m = members[member];
        if (!m.isActive) return;
        uint256 elapsed = block.timestamp - m.lastSettled;
        if (elapsed == 0) return;

        // Full-precision accrual: charge `seatPrice * elapsed / cycleDuration` rather
        // than a pre-floored `ratePerSecond`, so the owner collects the true streamed
        // amount instead of systematically under-collecting on every second.
        uint256 owed = (seatPrice * elapsed) / cycleDuration;
        if (owed >= m.buffer) {
            // buffer exhausted -> stream the remainder and exclude the seat
            owed = m.buffer;
            m.buffer = 0;
            m.pending += owed;
            m.lastSettled = block.timestamp;
            m.isActive = false;
            seatsTaken -= 1;
            emit Settled(member, owed, 0, m.pending);
            emit Excluded(member);
        } else {
            m.buffer -= owed;
            m.pending += owed;
            m.lastSettled = block.timestamp;
            emit Settled(member, owed, m.buffer, m.pending);
            uint256 runway = (m.buffer * cycleDuration) / seatPrice;
            if (runway <= reminderWindow) emit ReminderDue(member, runway);
        }
    }

    // ----------------------------------------------------------------------
    // Owner claim (proof-gated)
    // ----------------------------------------------------------------------

    /// @notice Owner withdraws streamed funds for a member — only if that member
    ///         has a fresh proof-of-access (i.e. the service was actually delivered).
    function ownerClaim(address member) external onlyOwner nonReentrant {
        Member storage m = members[member];
        if (m.inDispute) revert InDispute();
        _settle(member);
        if (block.timestamp - m.lastProof > proofValidity) revert StaleProof();
        uint256 amount = m.pending;
        if (amount == 0) revert NothingToClaim();
        m.pending = 0;
        token.safeTransfer(owner, amount);
        emit OwnerClaimed(member, amount);
    }

    // ----------------------------------------------------------------------
    // Member exit
    // ----------------------------------------------------------------------

    /// @notice Leave voluntarily: settle, then reclaim remaining buffer + bond.
    ///         Streamed `pending` remains for the owner to claim (service was used).
    /// @dev    Gated on `joined` (not `isActive`) so a member auto-excluded by buffer
    ///         exhaustion can still recover their still-posted bond. Buffer and bond are
    ///         zeroed, so a repeat call is a harmless no-op; `joined` is intentionally left
    ///         set so the owner can still prove access and claim any earned `pending`.
    function exit() external nonReentrant {
        Member storage m = members[msg.sender];
        if (!m.joined) revert NotMember();
        if (m.inDispute) revert InDispute();
        _settle(msg.sender);
        uint256 refund = m.buffer + m.bond;
        m.buffer = 0;
        m.bond = 0;
        if (m.isActive) {
            m.isActive = false;
            seatsTaken -= 1;
        }
        withdrawable[msg.sender] += refund;
        emit Exited(msg.sender, refund);
    }

    // ----------------------------------------------------------------------
    // Disputes (member claims service was not delivered)
    // ----------------------------------------------------------------------

    /// @notice Member opens a dispute (e.g. owner took money but removed access).
    ///         Freezes pending and escalates to the arbitrator.
    /// @dev Gated on `isActive` (not `joined`): only a member currently holding a seat
    ///      may dispute. This stops an already-exited member from re-freezing and clawing
    ///      back `pending` that legitimately belongs to the owner for delivered service.
    function raiseDispute(bytes calldata extraData) external payable nonReentrant returns (uint256 disputeId) {
        Member storage m = members[msg.sender];
        if (!m.isActive) revert NotMember();
        if (m.inDispute) revert InDispute();
        _settle(msg.sender);
        m.inDispute = true;
        openDisputes += 1;
        disputeId = arbitrator.createDispute{value: msg.value}(2, extraData);
        disputeToMember[disputeId] = msg.sender;
        emit DisputeRaised(msg.sender, disputeId);
    }

    /// @inheritdoc IArbitrable
    /// @notice ruling: 1 = member wins (refund pending + slash owner bond),
    ///                 2 = owner wins (release pending to owner),
    ///                 0 = tie (refund pending to member, no slash).
    function rule(uint256 disputeId, uint256 ruling) external override {
        if (msg.sender != address(arbitrator)) revert NotArbitrator();
        address member = disputeToMember[disputeId];
        Member storage m = members[member];
        require(m.inDispute, "no dispute");
        m.inDispute = false;
        openDisputes -= 1;
        // Clear the id->member mapping so a stale or duplicated arbitrator callback on
        // the same disputeId can't be replayed against the current member.
        delete disputeToMember[disputeId];

        uint256 amount = m.pending;
        m.pending = 0;

        if (ruling == 2) {
            // owner wins: streamed funds go to owner
            if (amount > 0) withdrawable[owner] += amount;
        } else if (amount > 0) {
            // member wins or tie: refund disputed funds to member.
            // The slash lives INSIDE `amount > 0`: the owner-bond penalty only applies
            // when there were actually streamed funds in dispute, so a member with zero
            // pending cannot extract a free slash.
            withdrawable[member] += amount;
            if (ruling == 1 && !m.slashed) {
                // penalty: slash owner bond to the member, but only ONCE per member —
                // otherwise a member could re-dispute after each win and drain the
                // entire owner bond with repeated slashAmount payouts.
                uint256 slash = slashAmount;
                if (slash > ownerBondBalance) slash = ownerBondBalance;
                ownerBondBalance -= slash;
                withdrawable[member] += slash;
                m.slashed = true;
            }
        }
        emit Ruled(member, disputeId, ruling);
    }

    // ----------------------------------------------------------------------
    // Withdrawals & owner bond reclaim
    // ----------------------------------------------------------------------

    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "nothing");
        withdrawable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Owner reclaims remaining bond once no seats are taken.
    function reclaimOwnerBond() external onlyOwner nonReentrant {
        require(seatsTaken == 0, "seats active");
        // Keep the bond locked while any dispute is unresolved, otherwise the owner
        // could drain it before a member-win ruling and dodge the slash.
        require(openDisputes == 0, "dispute pending");
        uint256 amount = ownerBondBalance;
        ownerBondBalance = 0;
        token.safeTransfer(owner, amount);
    }

    // ----------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------

    /// @notice Seconds of streaming runway left before exclusion (ignores accrual since lastSettled).
    function runwaySeconds(address member) public view returns (uint256) {
        Member storage m = members[member];
        if (!m.isActive) return 0;
        uint256 elapsed = block.timestamp - m.lastSettled;
        uint256 owed = (seatPrice * elapsed) / cycleDuration;
        if (owed >= m.buffer) return 0;
        return ((m.buffer - owed) * cycleDuration) / seatPrice;
    }

    /// @notice True if the member should be reminded to top up now.
    function reminderDue(address member) external view returns (bool) {
        Member storage m = members[member];
        if (!m.isActive) return false;
        return runwaySeconds(member) <= reminderWindow;
    }

    /// @notice True if the owner currently holds a claimable, proof-fresh balance.
    function ownerCanClaim(address member) external view returns (bool) {
        Member storage m = members[member];
        if (m.inDispute) return false;
        if (block.timestamp - m.lastProof > proofValidity) return false;
        uint256 elapsed = m.isActive ? block.timestamp - m.lastSettled : 0;
        uint256 accrued = (seatPrice * elapsed) / cycleDuration;
        uint256 projected = m.pending + (accrued > m.buffer ? m.buffer : accrued);
        return projected > 0;
    }
}
