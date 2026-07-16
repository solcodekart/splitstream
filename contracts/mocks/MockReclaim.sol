// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IReclaim, ReclaimProof, Claims} from "../interfaces/IReclaim.sol";

/// @title  MockReclaim — local stand-in for the deployed Reclaim beacon.
/// @notice Faithfully reproduces the SDK's claim serialisation + EIP-191 signature
///         recovery (verifier-solidity-sdk Claims.sol / StringUtils.sol) so tests can
///         mint *real* witness signatures with a local key and exercise the adapter's
///         authenticity gate. `verifyProof` reverts unless at least one signature over
///         the serialised claim recovers to the configured witness — mirroring the
///         real beacon's "reverts on bad witness signature" contract.
contract MockReclaim is IReclaim {
    address public immutable witness;

    constructor(address _witness) {
        witness = _witness;
    }

    /// @inheritdoc IReclaim
    function verifyProof(ReclaimProof memory proof) external view override {
        require(proof.signedClaim.signatures.length > 0, "No signatures");

        // Bind claimInfo (provider|parameters|context) to the signed identifier — this is
        // the check the REAL beacon performs (Reclaim.sol L157-158) and the reason the
        // adapter's member/pool/context bindings are sound: the witnesses sign a hash that
        // commits to the whole context, so it cannot be swapped after signing.
        require(proof.signedClaim.claim.identifier == _hashClaimInfo(proof.claimInfo), "identifier mismatch");

        bytes memory serialised = _serialise(proof.signedClaim.claim);
        bool found = false;
        for (uint256 i = 0; i < proof.signedClaim.signatures.length; i++) {
            if (_recover(serialised, proof.signedClaim.signatures[i]) == witness) {
                found = true;
                break;
            }
        }
        require(found, "Missing witness signature");
    }

    /// @dev keccak256(provider "\n" parameters "\n" context) — byte-for-byte with
    ///      SDK Claims.hashClaimInfo. The identifier the witnesses sign must equal this.
    function _hashClaimInfo(Claims.ClaimInfo memory ci) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(ci.provider, "\n", ci.parameters, "\n", ci.context));
    }

    // --- serialisation, byte-for-byte with SDK Claims.serialise -----------------

    function _serialise(Claims.CompleteClaimData memory c) private pure returns (bytes memory) {
        return abi.encodePacked(
            _bytes2str(abi.encodePacked(c.identifier)), "\n",
            _address2str(c.owner), "\n",
            _uint2str(uint256(c.timestampS)), "\n",
            _uint2str(uint256(c.epoch))
        );
    }

    function _recover(bytes memory content, bytes memory signature) private pure returns (address) {
        bytes32 signedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", _uint2str(content.length), content)
        );
        (bytes32 r, bytes32 s, uint8 v) = _split(signature);
        return ecrecover(signedHash, v, r, s);
    }

    function _split(bytes memory sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "bad sig len");
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
    }

    // --- string helpers, byte-for-byte with SDK StringUtils ---------------------

    function _address2str(address x) private pure returns (string memory) {
        bytes memory s = new bytes(40);
        for (uint256 i = 0; i < 20; i++) {
            bytes1 b = bytes1(uint8(uint256(uint160(x)) / (2 ** (8 * (19 - i)))));
            bytes1 hi = bytes1(uint8(b) / 16);
            bytes1 lo = bytes1(uint8(b) - 16 * uint8(hi));
            s[2 * i] = _getChar(hi);
            s[2 * i + 1] = _getChar(lo);
        }
        return string(abi.encodePacked("0x", s));
    }

    function _bytes2str(bytes memory buffer) private pure returns (string memory) {
        bytes memory converted = new bytes(buffer.length * 2);
        bytes memory base = "0123456789abcdef";
        for (uint256 i = 0; i < buffer.length; i++) {
            converted[i * 2] = base[uint8(buffer[i]) / 16];
            converted[i * 2 + 1] = base[uint8(buffer[i]) % 16];
        }
        return string(abi.encodePacked("0x", converted));
    }

    function _getChar(bytes1 b) private pure returns (bytes1) {
        if (uint8(b) < 10) return bytes1(uint8(b) + 0x30);
        return bytes1(uint8(b) + 0x57);
    }

    function _uint2str(uint256 i) private pure returns (string memory) {
        if (i == 0) return "0";
        uint256 j = i;
        uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (i != 0) {
            k = k - 1;
            bstr[k] = bytes1(uint8(48 + i % 10));
            i /= 10;
        }
        return string(bstr);
    }
}
