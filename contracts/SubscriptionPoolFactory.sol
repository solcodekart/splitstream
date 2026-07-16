// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SubscriptionPool} from "./SubscriptionPool.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {IArbitrator} from "./interfaces/IArbitrator.sol";

/// @title SubscriptionPoolFactory
/// @notice Deploys SubscriptionPool instances and indexes them for discovery.
contract SubscriptionPoolFactory {
    IProofVerifier public immutable proofVerifier;
    IArbitrator public immutable arbitrator;

    address[] public allPools;
    mapping(address => address[]) public poolsByOwner;

    event PoolCreated(address indexed owner, address indexed pool, string metadata);

    constructor(IProofVerifier _proofVerifier, IArbitrator _arbitrator) {
        proofVerifier = _proofVerifier;
        arbitrator = _arbitrator;
    }

    struct PoolParams {
        IERC20 token;
        uint256 seatPrice;
        uint256 cycleDuration;
        uint256 seatCount;
        uint256 ownerBondRequired;
        uint256 memberBondRequired;
        uint256 proofValidity;
        uint256 reminderWindow;
        uint256 slashAmount;
        bytes32 subscriptionRef;
        string metadata;
    }

    function createPool(PoolParams calldata p) external returns (address pool) {
        SubscriptionPool sp = new SubscriptionPool(
            msg.sender,
            p.token,
            p.seatPrice,
            p.cycleDuration,
            p.seatCount,
            p.ownerBondRequired,
            p.memberBondRequired,
            p.proofValidity,
            p.reminderWindow,
            p.slashAmount,
            p.subscriptionRef,
            proofVerifier,
            arbitrator,
            p.metadata
        );
        pool = address(sp);
        allPools.push(pool);
        poolsByOwner[msg.sender].push(pool);
        emit PoolCreated(msg.sender, pool, p.metadata);
    }

    function poolCount() external view returns (uint256) {
        return allPools.length;
    }
}
