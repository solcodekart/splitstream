// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IProofVerifier
/// @notice Abstraction over a zkTLS proof-of-access oracle (e.g. zkPass / Reclaim).
///         In production, `verify` checks a zero-knowledge proof that `member`
///         controls an account that is an active member of the subscription
///         identified by `pool` / `subscriptionRef`. No password is revealed.
/// @dev    Kept as an interface so the on-chain logic is independent of which
///         zkTLS provider is used, and so it can be swapped/upgraded.
interface IProofVerifier {
    /// @param member         the address whose access is being attested
    /// @param pool           the pool the proof is scoped to (prevents replay across pools)
    /// @param subscriptionRef opaque reference to the off-chain plan (e.g. household id hash)
    /// @param proof          the zkTLS proof blob
    /// @return ok            true iff the proof is valid and fresh
    /// @return observedAt    the witness/attestor timestamp the access was observed at
    ///                       (seconds). The pool stamps freshness from THIS, not from the
    ///                       submission block, so a single observation cannot be replayed to
    ///                       extend coverage. Undefined/ignored when `ok` is false; verifiers
    ///                       with no real observation clock (e.g. the mock) return
    ///                       `block.timestamp`.
    function verify(
        address member,
        address pool,
        bytes32 subscriptionRef,
        bytes calldata proof
    ) external view returns (bool ok, uint256 observedAt);
}
