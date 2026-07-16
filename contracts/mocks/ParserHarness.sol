// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReclaimAdapterVerifier} from "../ReclaimAdapterVerifier.sol";
import {IReclaim} from "../interfaces/IReclaim.sol";

/// @title  ParserHarness — test-only exposure of the adapter's JSON field parser.
/// @notice Inherits the production `ReclaimAdapterVerifier` and re-exports its `internal`
///         `_extractField` so a fuzzer can compare it, byte-for-byte, against a reference
///         port of the Reclaim SDK's `Claims.extractFieldFromContext`. Nothing here is
///         deployed to a real network; it exists purely to reach the private parser without
///         adding a test-only function to the production contract's external ABI.
/// @dev    The constructor forwards a dummy (nonzero) beacon + validity so the base
///         constructor's zero-checks pass; the parser is `pure` and never touches them.
contract ParserHarness is ReclaimAdapterVerifier {
    constructor() ReclaimAdapterVerifier(IReclaim(address(0xdead)), 1) {}

    function extract(string calldata data, string calldata target)
        external
        pure
        returns (string memory)
    {
        return _extractField(data, target);
    }
}
