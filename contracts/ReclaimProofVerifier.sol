// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title  ReclaimProofVerifier
/// @notice Production-shaped proof-of-access verifier backed by an off-chain zkTLS
///         attestor (a Reclaim witness or zkPass MPC node). The attestor observes the
///         member's *own* authenticated session on the platform's account page and signs
///         an attestation that binds the on-chain (member, pool, subscriptionRef) to a
///         freshness timestamp and an "access is active" assertion. This contract checks
///         that signature plus the binding and freshness. No credential, cookie, or access
///         token ever touches the chain — only the attestor's signature over a public claim.
///
/// @dev    Prototype simplifications vs a full Reclaim / zkPass integration:
///           - a single trusted `attestor` key stands in for an M-of-N witness quorum;
///           - the attestation is an EIP-191 signed struct hash, rather than Reclaim's
///             JSON claim/context blob parsed on-chain.
///         The security *shape* is identical — authenticity + binding + freshness +
///         assertion — so swapping in `Reclaim.verifyProof(...)` (and extracting
///         member/pool/ref/issuedAt from the signed context) is a localized change that
///         keeps this exact `IProofVerifier` surface. See docs/zktls-proof-spike.md.
contract ReclaimProofVerifier is IProofVerifier {
    /// @notice The zkTLS attestor whose signature gates access proofs.
    address public immutable attestor;
    /// @notice Max age (in seconds) of an attestation. Keep == pool.proofValidity.
    uint256 public immutable proofValidity;

    /// @dev Domain tag so our attestations can't collide with any other message the
    ///      attestor might sign.
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "AccessAttestation(address member,address pool,bytes32 subscriptionRef,uint256 issuedAt,bool active)"
    );

    /// @dev The `proof` bytes abi-decode into this: the attestor's verdict + signature.
    struct Attestation {
        uint256 issuedAt; // attestor's clock when it observed the live session
        bool active;      // true iff the member's plan / seat is live
        bytes signature;  // attestor sig over the EIP-191 digest of the struct hash
    }

    constructor(address _attestor, uint256 _proofValidity) {
        require(_attestor != address(0), "attestor=0");
        require(_proofValidity > 0, "validity=0");
        attestor = _attestor;
        proofValidity = _proofValidity;
    }

    /// @inheritdoc IProofVerifier
    /// @dev Pure `view`: returns false rather than reverting on a bad verdict, so the
    ///      pool's `require(..., "bad proof")` owns the revert. A malformed blob makes
    ///      `abi.decode` revert, which is fine — garbage in is a failed proof.
    function verify(
        address member,
        address pool,
        bytes32 subscriptionRef,
        bytes calldata proof
    ) external view override returns (bool ok, uint256 observedAt) {
        Attestation memory a = abi.decode(proof, (Attestation));

        // (1) assertion — access must be live.
        if (!a.active) return (false, 0);

        // (2) freshness — reject stale and future-dated attestations. This is what stops
        //     a valid-but-old proof from minting a fresh `lastProof` stamp in the pool.
        if (a.issuedAt > block.timestamp) return (false, 0);
        if (block.timestamp - a.issuedAt > proofValidity) return (false, 0);

        // (3) authenticity + binding — the attestor signed exactly these fields, so a proof
        //     issued for a different member / pool / plan can't be replayed here.
        bytes32 structHash = keccak256(
            abi.encode(ATTESTATION_TYPEHASH, member, pool, subscriptionRef, a.issuedAt, a.active)
        );
        // EIP-191 personal-sign digest, inlined to avoid pulling in OZ's
        // MessageHashUtils -> Strings -> Bytes.sol (which uses Cancun-only `mcopy`
        // and won't compile for our paris/ganache target). `\x19...\n32` is the
        // fixed 32-byte-message prefix; identical to toEthSignedMessageHash(bytes32).
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", structHash)
        );
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, a.signature);
        if (err != ECDSA.RecoverError.NoError) return (false, 0);
        // observedAt = the attestor's observation clock, so the pool measures freshness and
        // enforces single-use replay protection against the real observation time.
        return (signer == attestor, a.issuedAt);
    }
}
