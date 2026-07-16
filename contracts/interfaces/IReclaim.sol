// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  IReclaim — minimal, ABI-compatible view of the deployed Reclaim beacon.
/// @notice The official `@reclaimprotocol/verifier-solidity-sdk` pins `pragma solidity
///         0.8.4` and pulls in an old OpenZeppelin tree, so it cannot be compiled into a
///         0.8.26 / paris build — and it should not be, because Reclaim is already
///         deployed on every supported network (Ethereum, Base, Arbitrum, Polygon, …).
///         The correct integration is to call that deployed contract through an interface.
///
///         The struct layout below is byte-for-byte the SDK's `Reclaim.Proof` /
///         `Claims.*` (verified against verifier-solidity-sdk contracts/Claims.sol and
///         Reclaim.sol), so `abi.decode(bytes, (Proof))` of a proof produced by the JS
///         SDK, and the external `verifyProof(Proof)` call, are both wire-compatible.
library Claims {
    /// @dev Core signed claim data. `timestampS` is the witness-attested creation time
    ///      (seconds) — we use it as the on-chain freshness source.
    struct CompleteClaimData {
        bytes32 identifier;
        address owner;
        uint32 timestampS;
        uint32 epoch;
    }

    /// @dev `context` is a JSON string carrying `contextAddress` / `contextMessage`,
    ///      which is how the dApp binds a proof to (member, pool). `provider` names the
    ///      zkTLS provider (e.g. the Spotify-family-membership provider).
    struct ClaimInfo {
        string provider;
        string parameters;
        string context;
    }

    struct SignedClaim {
        CompleteClaimData claim;
        bytes[] signatures;
    }
}

/// @dev Top-level proof blob, identical to `Reclaim.Proof`.
struct ReclaimProof {
    Claims.ClaimInfo claimInfo;
    Claims.SignedClaim signedClaim;
}

/// @notice The subset of the Reclaim beacon we call: `verifyProof` reverts if the
///         witness signatures don't validate against the current epoch's witness set.
///         It is `view`, so a downstream `IProofVerifier.verify` can call it and stay view.
interface IReclaim {
    function verifyProof(ReclaimProof memory proof) external view;
}
