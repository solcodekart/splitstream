// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {IReclaim, ReclaimProof, Claims} from "./interfaces/IReclaim.sol";

/// @title  ReclaimAdapterVerifier
/// @notice Production adapter that gates `SubscriptionPool` access-proofs on the **real**
///         Reclaim Protocol beacon. It decodes a Reclaim proof produced by the frontend
///         (the reclaimprotocol js-sdk), asks the deployed `Reclaim` contract to check the
///         witness signatures, then enforces the four application-level properties the pool
///         needs — the same shape as the earlier signed-attestation prototype
///         (`ReclaimProofVerifier`), now backed by Reclaim's witness quorum instead of a
///         single local key.
///
/// @dev    Checks performed by `verify`:
///           (1) Authenticity — `Reclaim.verifyProof` validates the witness signatures over
///               the claim. A malformed blob or bad signatures ⇒ we return `false` (the
///               pool's `require(..., "bad proof")` owns the revert), never a bubble-up.
///           (2) Provider ⇄ plan binding — `keccak256(provider) == subscriptionRef`. The
///               pool's `subscriptionRef` IS the hash of the exact Reclaim provider name
///               (e.g. the "spotify-family-membership" provider). This is what stops a
///               member from substituting a cheap unrelated provider they *can* satisfy
///               (a "google-login" proof) to unlock a claim.
///           (3) Member binding — `context.contextAddress == member` (lowercase hex). Ties
///               the proof to the on-chain member being credited.
///           (4) Pool binding — `context.contextMessage == pool` (lowercase hex). Prevents
///               replaying one pool's proof against another pool sharing a provider.
///           (5) Freshness — `block.timestamp - claim.timestampS <= proofValidity`, and not
///               future-dated. A web proof is a point-in-time snapshot; this is what stops a
///               stale-but-valid proof from minting a fresh `lastProof` stamp in the pool.
///
///         Residual trust (inherent to point-in-time zkTLS, documented in
///         docs/zktls-proof-spike.md §2–3): the guarantee is "an active plan membership was
///         observed, bound to (member, pool), within `proofValidity`", assuming the Reclaim
///         witness quorum + TLS/CA are honest — not a standalone SNARK of the session.
contract ReclaimAdapterVerifier is IProofVerifier {
    /// @notice The deployed Reclaim beacon for this network (see Addresses.sol in the SDK).
    IReclaim public immutable reclaim;
    /// @notice Max age (seconds) of a proof's witness timestamp. Keep == pool.proofValidity.
    uint256 public immutable proofValidity;

    constructor(IReclaim _reclaim, uint256 _proofValidity) {
        require(address(_reclaim) != address(0), "reclaim=0");
        require(_proofValidity > 0, "validity=0");
        reclaim = _reclaim;
        proofValidity = _proofValidity;
    }

    /// @inheritdoc IProofVerifier
    function verify(
        address member,
        address pool,
        bytes32 subscriptionRef,
        bytes calldata proof
    ) external view override returns (bool ok, uint256 observedAt) {
        // Decode defensively: a malformed blob makes abi.decode revert, so wrap the whole
        // body and translate any revert (including Reclaim's) into a clean `(false, 0)`.
        try this.decodeAndCheck(member, pool, subscriptionRef, proof) returns (bool _ok, uint256 _at) {
            return (_ok, _at);
        } catch {
            return (false, 0);
        }
    }

    /// @dev External-but-self-called so `verify` can `try/catch` both the abi.decode and the
    ///     Reclaim call. Reverting here (bad proof / decode) surfaces as `(false, 0)` above.
    ///     Returns the witness-attested observation time so the pool can stamp freshness and
    ///     enforce single-use replay protection from the real observation, not the block.
    function decodeAndCheck(
        address member,
        address pool,
        bytes32 subscriptionRef,
        bytes calldata proof
    ) external view returns (bool ok, uint256 observedAt) {
        require(msg.sender == address(this), "internal");
        ReclaimProof memory p = abi.decode(proof, (ReclaimProof));

        // (1) authenticity — reverts if witness signatures don't validate.
        reclaim.verifyProof(p);

        // (5) freshness — witness-attested claim time.
        uint256 issuedAt = uint256(p.signedClaim.claim.timestampS);

        // (2) provider ⇄ plan binding.
        if (keccak256(bytes(p.claimInfo.provider)) != subscriptionRef) return (false, 0);

        if (issuedAt > block.timestamp) return (false, 0);
        if (block.timestamp - issuedAt > proofValidity) return (false, 0);

        // (3) member binding — contextAddress must equal `member` (lowercase hex).
        string memory ctxAddr = _extractField(p.claimInfo.context, '"contextAddress":"');
        if (!_eq(ctxAddr, _toHexString(member))) return (false, 0);

        // (4) pool binding — contextMessage must equal `pool` (lowercase hex).
        string memory ctxMsg = _extractField(p.claimInfo.context, '"contextMessage":"');
        if (!_eq(ctxMsg, _toHexString(pool))) return (false, 0);

        return (true, issuedAt);
    }

    // ----------------------------------------------------------------------
    // Internal string / hex helpers (paris-safe; no OZ Strings/Bytes mcopy).
    // ----------------------------------------------------------------------

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// @dev Lowercase `0x`-prefixed 40-char hex of an address — matches how the JS SDK
    ///      serialises an address into the proof context.
    function _toHexString(address a) private pure returns (string memory) {
        bytes16 HEX = 0x30313233343536373839616263646566; // "0123456789abcdef"
        bytes20 b = bytes20(a);
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            out[2 + i * 2] = HEX[uint8(b[i]) >> 4];
            out[3 + i * 2] = HEX[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }

    /// @dev Extract a JSON string field value from `data` given a `target` like
    ///      `"contextAddress":"`. Reads to the next unescaped quote. Faithful port of the
    ///      SDK's `Claims.extractFieldFromContext`; returns "" if missing/malformed.
    function _extractField(string memory data, string memory target)
        internal
        pure
        returns (string memory)
    {
        bytes memory d = bytes(data);
        bytes memory t = bytes(target);
        if (d.length < t.length) return "";

        uint256 start = 0;
        bool found = false;
        for (uint256 i = 0; i <= d.length - t.length; i++) {
            bool isMatch = true;
            for (uint256 j = 0; j < t.length && isMatch; j++) {
                if (d[i + j] != t[j]) isMatch = false;
            }
            if (isMatch) {
                start = i + t.length;
                found = true;
                break;
            }
        }
        if (!found) return "";

        uint256 end = start;
        while (end < d.length && !(d[end] == '"' && d[end - 1] != "\\")) {
            end++;
        }
        if (end <= start || end >= d.length) return "";

        bytes memory val = new bytes(end - start);
        for (uint256 k = start; k < end; k++) val[k - start] = d[k];
        return string(val);
    }
}
