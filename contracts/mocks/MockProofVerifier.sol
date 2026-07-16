// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IProofVerifier} from "../interfaces/IProofVerifier.sol";

/// @notice Test double for the zkTLS oracle. Lets tests toggle whether a given
///         member's proof should verify. In production this is replaced by a
///         zkPass / Reclaim on-chain verifier that checks a real proof blob.
contract MockProofVerifier is IProofVerifier {
    mapping(address => bool) public accepts;

    function setAccepts(address member, bool ok) external {
        accepts[member] = ok;
    }

    function verify(
        address member,
        address, /* pool */
        bytes32, /* subscriptionRef */
        bytes calldata /* proof */
    ) external view override returns (bool ok, uint256 observedAt) {
        // The mock has no real observation clock, so it reports "observed now". The pool's
        // strict-monotonic replay guard still applies, so the demo host must let time pass
        // between successive proofs (as it does in normal use).
        return (accepts[member], block.timestamp);
    }
}
