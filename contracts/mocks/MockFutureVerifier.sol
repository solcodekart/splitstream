// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// @notice Adversarial test double: a *broken* verifier that approves a proof but reports an
///         observation time in the FUTURE. Used to prove the pool's `BadProofTime` guard
///         rejects it (rather than stamping `lastProof` ahead of `block.timestamp` and
///         bricking `ownerClaim` with an underflow). No real verifier behaves this way; this
///         exists only to exercise the pool's defense-in-depth check.
contract MockFutureVerifier is IProofVerifier {
    uint256 public immutable skew; // seconds into the future to report

    constructor(uint256 _skew) {
        skew = _skew;
    }

    function verify(
        address, /* member */
        address, /* pool */
        bytes32, /* subscriptionRef */
        bytes calldata /* proof */
    ) external view override returns (bool ok, uint256 observedAt) {
        return (true, block.timestamp + skew);
    }
}
