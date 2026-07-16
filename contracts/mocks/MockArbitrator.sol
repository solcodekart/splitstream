// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IArbitrator, IArbitrable} from "../interfaces/IArbitrator.sol";

/// @notice Test double for the Kleros court. Records disputes and lets the test
///         deliver a ruling, which is relayed back to the arbitrable contract.
contract MockArbitrator is IArbitrator {
    uint256 public nextDisputeId;
    mapping(uint256 => address) public arbitrableOf;

    event DisputeCreated(uint256 indexed disputeId, address indexed arbitrable);

    function createDispute(uint256, /* choices */ bytes calldata /* extraData */)
        external
        payable
        override
        returns (uint256 disputeId)
    {
        disputeId = nextDisputeId++;
        arbitrableOf[disputeId] = msg.sender;
        emit DisputeCreated(disputeId, msg.sender);
    }

    /// @notice Simulate the jury reaching a verdict.
    function giveRuling(uint256 disputeId, uint256 ruling) external {
        IArbitrable(arbitrableOf[disputeId]).rule(disputeId, ruling);
    }
}
