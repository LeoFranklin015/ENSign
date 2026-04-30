// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@account-abstraction/core/Helpers.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { PreparePackedUserOp } from "../../script/PreparePackedUserOp.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { ERC7739Utils } from "../utils/ERC7739Utils.sol";

/**
 * @title Test7702SignatureValidation
 * @notice Unit tests for EIP-7702 direct ECDSA signature validation (64/65 byte signatures)
 * @dev Tests the direct ECDSA signature validation path in JustanAccount._validateSignature()
 */
contract Test7702SignatureValidation is Test, CodeConstants {

    JustanAccount public justanAccount;
    HelperConfig.NetworkConfig public networkConfig;
    PreparePackedUserOp public preparePackedUserOp;

    bytes CALLDATA = abi.encodeWithSignature("execute(address,uint256,bytes)", address(0), 0, "");

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount,, networkConfig) = deployer.run();

        preparePackedUserOp = new PreparePackedUserOp();

        // Delegate to the test account
        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);
    }

    /*//////////////////////////////////////////////////////////////
                    EIP-7702 DIRECT ECDSA SIGNATURE TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateCorrectSignature() public {
        (PackedUserOperation memory userOp, bytes32 userOpHash) =
            preparePackedUserOp.generateSignedUserOperation(CALLDATA, networkConfig.entryPointAddress);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = JustanAccount(TEST_ACCOUNT_ADDRESS).validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_SUCCESS);
    }

    /**
     * FLOW EXPLANATION:
     *
     * This fuzz test verifies that EIP-7702 signature validation fails when the signature
     * is signed by the wrong private key for a given delegated account.
     *
     * Setup:
     * 1. Create Account A with fuzzed private key A (nonDelegatedPk)
     * 2. Account A delegates to JustanAccount implementation via EIP-7702
     * 3. Create UserOp signed with TEST_ACCOUNT_PRIVATE_KEY (different from private key A)
     *
     * Validation Flow:
     * 1. Call validateUserOp() on Account A (which now has JustanAccount code)
     * 2. JustanAccount._validateSignature() calls _erc1271IsValidSignatureNowCalldata()
     * 3. Since signature is 65 bytes, it goes through ECDSA path:
     *    - ECDSA.tryRecover(hash, signature) recovers TEST_ACCOUNT_ADDRESS
     *    - _erc1271Signer() returns nonDelegatedAccount (address(this))
     *    - Comparison: TEST_ACCOUNT_ADDRESS == nonDelegatedAccount? → FALSE
     * 4. Returns SIG_VALIDATION_FAILED
     *
     * This demonstrates that each delegated account must be signed by its own private key.
     */
    function test_ShouldFailWhenNotDelegated(uint256 nonDelegatedPk) public {
        vm.assume(nonDelegatedPk > 0);
        vm.assume(nonDelegatedPk < SECP256K1_CURVE_ORDER);
        vm.assume(nonDelegatedPk != TEST_ACCOUNT_PRIVATE_KEY);

        address nonDelegatedAccount = vm.addr(nonDelegatedPk);

        vm.signAndAttachDelegation(address(justanAccount), nonDelegatedPk);

        (PackedUserOperation memory userOp, bytes32 userOpHash) =
            preparePackedUserOp.generateSignedUserOperation(CALLDATA, networkConfig.entryPointAddress);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = JustanAccount(payable(nonDelegatedAccount)).validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldFailWithOversizedSignature(uint256 signatureLength) public {
        vm.assume(signatureLength >= 66);
        vm.assume(signatureLength < 200);

        (PackedUserOperation memory userOp, bytes32 userOpHash) =
            preparePackedUserOp.generateSignedUserOperation(CALLDATA, networkConfig.entryPointAddress);

        userOp.signature = new bytes(signatureLength);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = JustanAccount(TEST_ACCOUNT_ADDRESS).validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldRevertWithUndersizedSignature(uint256 signatureLength) public {
        vm.assume(signatureLength < 64);

        (PackedUserOperation memory userOp, bytes32 userOpHash) =
            preparePackedUserOp.generateSignedUserOperation(CALLDATA, networkConfig.entryPointAddress);

        userOp.signature = new bytes(signatureLength);

        vm.prank(networkConfig.entryPointAddress);
        vm.expectRevert();
        JustanAccount(TEST_ACCOUNT_ADDRESS).validateUserOp(userOp, userOpHash, 0);
    }

    /*//////////////////////////////////////////////////////////////
                    EIP-1271 TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateECDSAPersonalSign(string memory message) public {
        bytes32 personalSignHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", bytes(message).length, message));

        ERC7739Utils.DomainData memory domainData = ERC7739Utils.getDomainDataFromAccount(TEST_ACCOUNT_ADDRESS);
        bytes32 erc7739Hash = ERC7739Utils.erc7739HashFromPersonalSignHash(personalSignHash, domainData);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_ACCOUNT_PRIVATE_KEY, erc7739Hash);
        bytes memory ecdsaSignature = abi.encodePacked(r, s, v);

        bytes4 result = JustanAccount(TEST_ACCOUNT_ADDRESS).isValidSignature(personalSignHash, ecdsaSignature);
        assertEq(result, IERC1271.isValidSignature.selector);
    }

    function test_ShouldValidateECDSAEIP712StructuredMessage() public {
        // Create EIP-712 struct hash for Mail(address to,string contents)
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Mail(address to,string contents)"),
                address(0x1234567890123456789012345678901234567890),
                keccak256("Hello, EIP-712!")
            )
        );

        ERC7739Utils.DomainData memory domainData = ERC7739Utils.getDomainDataFromAccount(TEST_ACCOUNT_ADDRESS);
        bytes32 erc7739Hash = ERC7739Utils.erc7739HashFromPersonalSignHash(structHash, domainData);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_ACCOUNT_PRIVATE_KEY, erc7739Hash);
        bytes memory ecdsaSignature = abi.encodePacked(r, s, v);

        bytes4 result = JustanAccount(TEST_ACCOUNT_ADDRESS).isValidSignature(structHash, ecdsaSignature);
        assertEq(result, IERC1271.isValidSignature.selector);
    }

}
