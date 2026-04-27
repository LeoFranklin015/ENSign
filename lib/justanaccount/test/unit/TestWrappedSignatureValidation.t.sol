// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@account-abstraction/core/Helpers.sol";

import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { PreparePackedUserOp } from "../../script/PreparePackedUserOp.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { JustanAccountFactory } from "../../src/JustanAccountFactory.sol";
import { ERC7739Utils } from "../utils/ERC7739Utils.sol";

/**
 * @title TestWrappedSignatureValidation
 * @notice Unit tests for SignatureWrapper validation (multi-owner ECDSA signatures)
 * @dev Tests the wrapped signature validation path in JustanAccount._validateSignature()
 *      for signatures longer than 65 bytes that use the SignatureWrapper struct
 *      Uses factory to create account clones with initial owners
 */
contract TestWrappedSignatureValidation is Test, CodeConstants {

    JustanAccount public account;
    JustanAccountFactory public factory;
    HelperConfig.NetworkConfig public networkConfig;
    PreparePackedUserOp public preparePackedUserOp;

    uint256 public initialOwnerPk = TEST_ACCOUNT_PRIVATE_KEY;
    address public initialOwner = TEST_ACCOUNT_ADDRESS;

    bytes CALLDATA = abi.encodeWithSignature("execute(address,uint256,bytes)", address(0), 0, "");

    function setUp() public {
        DeployJustanAccount deployer = new DeployJustanAccount();
        (, factory, networkConfig) = deployer.run();

        preparePackedUserOp = new PreparePackedUserOp();

        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(initialOwner);

        account = factory.createAccount(owners, 0);
    }

    /*//////////////////////////////////////////////////////////////
                    EIP-1271 TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateECDSAPersonalSign(string memory message) public {
        bytes32 personalSignHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", bytes(message).length, message));

        ERC7739Utils.DomainData memory domainData = ERC7739Utils.getDomainDataFromAccount(address(account));
        bytes32 erc7739Hash = ERC7739Utils.erc7739HashFromPersonalSignHash(personalSignHash, domainData);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(initialOwnerPk, erc7739Hash);
        bytes memory ecdsaSignature = abi.encodePacked(r, s, v);

        bytes memory signature =
            abi.encode(JustanAccount.SignatureWrapper({ ownerIndex: 0, signatureData: ecdsaSignature }));

        bytes4 result = account.isValidSignature(personalSignHash, signature);
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

        ERC7739Utils.DomainData memory domainData = ERC7739Utils.getDomainDataFromAccount(address(account));
        bytes32 erc7739Hash = ERC7739Utils.erc7739HashFromPersonalSignHash(structHash, domainData);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(initialOwnerPk, erc7739Hash);
        bytes memory ecdsaSignature = abi.encodePacked(r, s, v);

        bytes memory signature =
            abi.encode(JustanAccount.SignatureWrapper({ ownerIndex: 0, signatureData: ecdsaSignature }));

        bytes4 result = account.isValidSignature(structHash, signature);
        assertEq(result, IERC1271.isValidSignature.selector);
    }

    /*//////////////////////////////////////////////////////////////
                    WRAPPED SIGNATURE CHECKS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldFailWrappedSignatureWithRemovedOwner(uint256 newOwnerPk) public {
        vm.assume(newOwnerPk > 0 && newOwnerPk < SECP256K1_CURVE_ORDER);
        vm.assume(newOwnerPk != initialOwnerPk);

        address newOwner = vm.addr(newOwnerPk);

        vm.prank(initialOwner);
        account.addOwnerAddress(newOwner);

        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateSignedUserOperation(
            CALLDATA, newOwner, newOwnerPk, networkConfig.entryPointAddress, false
        );

        JustanAccount.SignatureWrapper memory sigWrapper =
            JustanAccount.SignatureWrapper({ ownerIndex: 1, signatureData: userOp.signature });

        userOp.signature = abi.encode(sigWrapper);

        vm.prank(initialOwner);
        account.removeOwnerAtIndex(1, abi.encode(newOwner));

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    /*//////////////////////////////////////////////////////////////
                    WRAPPED SIGNATURE (SignatureWrapper) TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateWrappedSignature(uint256 newOwnerPk) public {
        vm.assume(newOwnerPk > 0 && newOwnerPk < SECP256K1_CURVE_ORDER);
        vm.assume(newOwnerPk != initialOwnerPk);

        address newOwner = vm.addr(newOwnerPk);

        vm.prank(initialOwner);
        account.addOwnerAddress(newOwner);

        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateSignedUserOperation(
            CALLDATA, newOwner, newOwnerPk, networkConfig.entryPointAddress, false
        );

        JustanAccount.SignatureWrapper memory sigWrapper =
            JustanAccount.SignatureWrapper({ ownerIndex: 1, signatureData: userOp.signature });

        userOp.signature = abi.encode(sigWrapper);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_SUCCESS);
    }

    function test_ShouldFailWrappedSignatureWithoutOwner(uint256 nonOwnerPk) public {
        vm.assume(nonOwnerPk > 0 && nonOwnerPk < SECP256K1_CURVE_ORDER);
        vm.assume(nonOwnerPk != initialOwnerPk);

        address nonOwner = vm.addr(nonOwnerPk);

        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateSignedUserOperation(
            CALLDATA, nonOwner, nonOwnerPk, networkConfig.entryPointAddress, false
        );

        JustanAccount.SignatureWrapper memory sigWrapper =
            JustanAccount.SignatureWrapper({ ownerIndex: 0, signatureData: userOp.signature });

        userOp.signature = abi.encode(sigWrapper);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldFailWrappedSignatureWithWrongSigner(uint256 newOwnerPk, uint256 wrongSignerPk) public {
        vm.assume(newOwnerPk > 0 && newOwnerPk < SECP256K1_CURVE_ORDER);
        vm.assume(wrongSignerPk > 0 && wrongSignerPk < SECP256K1_CURVE_ORDER);
        vm.assume(newOwnerPk != initialOwnerPk);
        vm.assume(wrongSignerPk != newOwnerPk);
        vm.assume(wrongSignerPk != initialOwnerPk);

        address newOwner = vm.addr(newOwnerPk);

        vm.prank(initialOwner);
        account.addOwnerAddress(newOwner);

        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateSignedUserOperation(
            CALLDATA, newOwner, wrongSignerPk, networkConfig.entryPointAddress, false
        );

        JustanAccount.SignatureWrapper memory sigWrapper =
            JustanAccount.SignatureWrapper({ ownerIndex: 1, signatureData: userOp.signature });

        userOp.signature = abi.encode(sigWrapper);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

}
