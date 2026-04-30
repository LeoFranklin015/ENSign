// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { Script } from "forge-std/Script.sol";

import { CodeConstants } from "./HelperConfig.s.sol";

contract PreparePackedUserOp is Script, CodeConstants {

    using MessageHashUtils for bytes32;

    /**
     * @notice Generates a signed UserOperation with custom sender and signer
     * @param callData The calldata for the UserOperation
     * @param sender The address of the account that will execute the operation
     * @param signerPrivateKey The private key to sign the operation with
     * @param entryPoint The EntryPoint contract address
     * @param isEIP7702 Whether this is for EIP-7702 delegation (true) or factory accounts (false)
     * @return userOp The signed UserOperation
     * @return userOpHash The hash of the UserOperation
     */
    function generateSignedUserOperation(
        bytes memory callData,
        address sender,
        uint256 signerPrivateKey,
        address entryPoint,
        bool isEIP7702
    )
        public
        view
        returns (PackedUserOperation memory userOp, bytes32 userOpHash)
    {
        uint256 nonce = IEntryPoint(entryPoint).getNonce(sender, 0);
        userOp = _generateUnsignedUserOperation(callData, sender, nonce, isEIP7702);
        userOpHash = IEntryPoint(entryPoint).getUserOpHash(userOp);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, userOpHash);
        userOp.signature = abi.encodePacked(r, s, v);

        return (userOp, userOpHash);
    }

    /**
     * @notice Convenience method that generates a signed UserOperation using TEST_ACCOUNT defaults
     * @param callData The calldata for the UserOperation
     * @param entryPoint The EntryPoint contract address
     * @return userOp The signed UserOperation
     * @return userOpHash The hash of the UserOperation
     */
    function generateSignedUserOperation(
        bytes memory callData,
        address entryPoint
    )
        public
        view
        returns (PackedUserOperation memory userOp, bytes32 userOpHash)
    {
        return generateSignedUserOperation(callData, TEST_ACCOUNT_ADDRESS, TEST_ACCOUNT_PRIVATE_KEY, entryPoint, true);
    }

    /**
     * @notice Generates an unsigned UserOperation for manual signing
     * @param callData The calldata for the UserOperation
     * @param sender The address of the account that will execute the operation
     * @param entryPoint The EntryPoint contract address
     * @param isEIP7702 Whether this is for EIP-7702 delegation (true) or factory accounts (false)
     * @return userOp The unsigned UserOperation
     * @return userOpHash The hash of the UserOperation
     */
    function generateUnsignedUserOperation(
        bytes memory callData,
        address sender,
        address entryPoint,
        bool isEIP7702
    )
        public
        view
        returns (PackedUserOperation memory userOp, bytes32 userOpHash)
    {
        uint256 nonce = IEntryPoint(entryPoint).getNonce(sender, 0);
        userOp = _generateUnsignedUserOperation(callData, sender, nonce, isEIP7702);
        userOpHash = IEntryPoint(entryPoint).getUserOpHash(userOp);
        return (userOp, userOpHash);
    }

    function _generateUnsignedUserOperation(
        bytes memory callData,
        address sender,
        uint256 nonce,
        bool isEIP7702
    )
        internal
        pure
        returns (PackedUserOperation memory)
    {
        uint128 verificationGasLimit = 16_777_216;
        uint128 callGasLimit = verificationGasLimit;
        uint128 maxPriorityFeePerGas = 256;
        uint128 maxFeePerGas = maxPriorityFeePerGas;

        // Use EIP-7702 marker for delegation, empty for factory accounts
        bytes memory initCode =
            isEIP7702 ? abi.encodePacked(bytes20(0x7702000000000000000000000000000000000000)) : bytes("");

        return PackedUserOperation({
            sender: sender,
            nonce: nonce,
            initCode: initCode,
            callData: callData,
            accountGasLimits: bytes32(uint256(verificationGasLimit) << 128 | callGasLimit),
            preVerificationGas: verificationGasLimit,
            gasFees: bytes32(uint256(maxPriorityFeePerGas) << 128 | maxFeePerGas),
            paymasterAndData: hex"",
            signature: hex""
        });
    }

}
