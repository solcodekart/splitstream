// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IArbitrable
/// @notice Contract that can receive a ruling from an arbitrator (Kleros-style).
interface IArbitrable {
    /// @notice Called by the arbitrator to deliver the final ruling.
    /// @param disputeId the dispute identifier
    /// @param ruling    0 = refused/tie, 1 = member wins, 2 = owner wins
    function rule(uint256 disputeId, uint256 ruling) external;
}

/// @title IArbitrator
/// @notice Minimal Kleros-style arbitrator abstraction. In production this is the
///         Kleros court: staked PNK jurors, commit-reveal voting, appeals.
interface IArbitrator {
    /// @param choices    number of ruling options
    /// @param extraData  court/jury config
    /// @return disputeId the created dispute id
    function createDispute(uint256 choices, bytes calldata extraData)
        external
        payable
        returns (uint256 disputeId);
}
