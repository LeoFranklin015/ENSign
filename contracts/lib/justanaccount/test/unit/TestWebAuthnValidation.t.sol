// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@account-abstraction/core/Helpers.sol";

import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import { P256 } from "@solady/utils/P256.sol";
import { WebAuthn } from "@solady/utils/WebAuthn.sol";
import { FCL_Elliptic_ZZ } from "FreshCryptoLib/FCL_elliptic.sol";
import { Base64Url } from "FreshCryptoLib/utils/Base64Url.sol";
import { Test, Vm } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { PreparePackedUserOp } from "../../script/PreparePackedUserOp.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { JustanAccountFactory } from "../../src/JustanAccountFactory.sol";
import { ERC7739Utils } from "../utils/ERC7739Utils.sol";

library Utils {

    uint256 constant P256_N_DIV_2 = FCL_Elliptic_ZZ.n / 2;

    struct WebAuthnInfo {
        bytes authenticatorData;
        string clientDataJSON;
        bytes32 messageHash;
    }

    function getWebAuthnStruct(bytes32 challenge) public pure returns (WebAuthnInfo memory) {
        bytes memory challengeBytes = abi.encode(challenge);
        string memory challengeb64url = Base64Url.encode(challengeBytes);
        // TODO: Change to use the correct origin
        string memory clientDataJSON = string(
            abi.encodePacked(
                '{"type":"webauthn.get","challenge":"',
                challengeb64url,
                '","origin":"https://keys.jaw.id","crossOrigin":false}'
            )
        );

        bytes memory authenticatorData = hex"49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630500000000";

        bytes32 clientDataJSONHash = sha256(bytes(clientDataJSON));
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, clientDataJSONHash));

        return WebAuthnInfo(authenticatorData, clientDataJSON, messageHash);
    }

    /// @dev normalizes the s value from a p256r1 signature so that
    /// it will pass malleability checks.
    function normalizeS(uint256 s) public pure returns (uint256) {
        if (s > P256_N_DIV_2) {
            return FCL_Elliptic_ZZ.n - s;
        }

        return s;
    }

}

contract TestWebAuthnValidation is Test, CodeConstants {

    JustanAccount public account;
    JustanAccountFactory public factory;
    HelperConfig.NetworkConfig public networkConfig;
    PreparePackedUserOp public preparePackedUserOp;

    uint256 passkeyPrivateKey = uint256(0x03d99692017473e2d631945a812607b23269d85721e0f370b8d3e7d29a874fd2);
    bytes passkeyOwner =
        hex"1c05286fe694493eae33312f2d2e0d0abeda8db76238b7a204be1fb87f54ce4228fef61ef4ac300f631657635c28e59bfb2fe71bce1634c81c65642042f6dc4d";
    bytes CALLDATA = abi.encodeWithSignature("execute(address,uint256,bytes)", address(0), 0, "");

    function setUp() public {
        // Deploy P256 verifier bytecode to the precompile addresses
        // This is required for WebAuthn signature verification in tests
        vm.etch(P256.RIP_PRECOMPILE, P256_VERIFIER_BYTECODE);
        vm.etch(P256.VERIFIER, P256_VERIFIER_BYTECODE);

        DeployJustanAccount deployer = new DeployJustanAccount();
        (, factory, networkConfig) = deployer.run();

        preparePackedUserOp = new PreparePackedUserOp();

        bytes[] memory owners = new bytes[](1);
        owners[0] = passkeyOwner;

        account = factory.createAccount(owners, 0);
    }

    /*//////////////////////////////////////////////////////////////
                    VALID SIGNATURE CHECKS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateWebAuthnSignature() public {
        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 0,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_SUCCESS);
    }

    function test_ShouldValidateWebAuthnPersonalSign(string memory message) public {
        bytes32 personalSignHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n11", message));

        ERC7739Utils.DomainData memory domainData = ERC7739Utils.getDomainDataFromAccount(address(account));
        bytes32 erc7739Hash = ERC7739Utils.erc7739HashFromPersonalSignHash(personalSignHash, domainData);

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(erc7739Hash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        bytes memory signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 0,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        bytes4 result = account.isValidSignature(personalSignHash, signature);
        assertEq(result, IERC1271.isValidSignature.selector);
    }

    function test_ShouldValidateWebAuthnEIP712StructuredMessage() public {
        // Create EIP-712 struct hash for Mail(address to,string contents)
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Mail(address to,string contents)"),
                address(0x1234567890123456789012345678901234567890),
                keccak256("Hello, EIP-712!")
            )
        );

        // Get the account's domain data and create the EIP-712 typed data hash
        ERC7739Utils.DomainData memory domainData = ERC7739Utils.getDomainDataFromAccount(address(account));
        bytes32 erc7739Hash = ERC7739Utils.erc7739HashFromPersonalSignHash(structHash, domainData);

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(erc7739Hash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        bytes memory signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 0,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        bytes4 result = account.isValidSignature(structHash, signature);
        assertEq(result, IERC1271.isValidSignature.selector);
    }

    /*//////////////////////////////////////////////////////////////
                    INVALID OWNER INDEX TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldFailWebAuthnSignatureWithInvalidOwnerIndex(uint256 ownerIndex) public {
        vm.assume(ownerIndex >= account.nextOwnerIndex());

        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: ownerIndex,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldFailWebAuthnSignatureWithRemovedOwner(uint256 newOwnerPk) public {
        uint256 P256_CURVE_ORDER = FCL_Elliptic_ZZ.n;
        vm.assume(newOwnerPk > 0 && newOwnerPk < P256_CURVE_ORDER);
        vm.assume(newOwnerPk != passkeyPrivateKey);

        (uint256 newXUint, uint256 newYUint) = vm.publicKeyP256(newOwnerPk);
        bytes32 newX = bytes32(newXUint);
        bytes32 newY = bytes32(newYUint);
        bytes memory newOwner = abi.encode(newX, newY);

        vm.prank(address(account));
        account.addOwnerPublicKey(newX, newY);

        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(newOwnerPk, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 1,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(address(account));
        account.removeOwnerAtIndex(1, newOwner);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    /*//////////////////////////////////////////////////////////////
                    WRONG OWNER/SIGNER TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldFailWebAuthnSignatureWithWrongKey(uint256 owner1Pk, uint256 owner2Pk) public {
        uint256 P256_CURVE_ORDER = FCL_Elliptic_ZZ.n;
        vm.assume(owner1Pk > 0 && owner1Pk < P256_CURVE_ORDER);
        vm.assume(owner2Pk > 0 && owner2Pk < P256_CURVE_ORDER);
        vm.assume(owner1Pk != passkeyPrivateKey);
        vm.assume(owner2Pk != passkeyPrivateKey);
        vm.assume(owner1Pk != owner2Pk);

        (uint256 owner1XUint, uint256 owner1YUint) = vm.publicKeyP256(owner1Pk);
        bytes32 owner1X = bytes32(owner1XUint);
        bytes32 owner1Y = bytes32(owner1YUint);

        vm.prank(address(account));
        account.addOwnerPublicKey(owner1X, owner1Y);

        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(owner2Pk, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 1,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    /*//////////////////////////////////////////////////////////////
                    WEBAUTHN-SPECIFIC FIELD TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldFailWebAuthnSignatureWithWrongTypeIndex() public {
        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 0,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 0,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldFailWebAuthnSignatureWithWrongChallengeIndex() public {
        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 0,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 0,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldFailWebAuthnSignatureWithTamperedAuthenticatorData() public {
        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        bytes memory tamperedAuthenticatorData = webAuthn.authenticatorData;
        tamperedAuthenticatorData[0] = bytes1(uint8(tamperedAuthenticatorData[0]) ^ 0x01);

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 0,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: tamperedAuthenticatorData,
                        clientDataJSON: webAuthn.clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldFailWebAuthnSignatureWithTamperedClientDataJSON() public {
        (PackedUserOperation memory userOp, bytes32 userOpHash) = preparePackedUserOp.generateUnsignedUserOperation(
            CALLDATA, address(account), networkConfig.entryPointAddress, false
        );

        Utils.WebAuthnInfo memory webAuthn = Utils.getWebAuthnStruct(userOpHash);
        (bytes32 r, bytes32 s) = vm.signP256(passkeyPrivateKey, webAuthn.messageHash);
        s = bytes32(Utils.normalizeS(uint256(s)));

        string memory tamperedClientDataJSON = string(
            abi.encodePacked(
                '{"type":"webauthn.get","challenge":"tampered","origin":"https://sign.coinbase.com","crossOrigin":false}'
            )
        );

        userOp.signature = abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: 0,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: webAuthn.authenticatorData,
                        clientDataJSON: tamperedClientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

}
