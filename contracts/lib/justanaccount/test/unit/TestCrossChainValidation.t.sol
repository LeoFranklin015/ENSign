// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@account-abstraction/core/Helpers.sol";
import { IEntryPoint } from "@account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "@account-abstraction/interfaces/PackedUserOperation.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { P256 } from "@solady/utils/P256.sol";
import { WebAuthn } from "@solady/utils/WebAuthn.sol";
import { FCL_Elliptic_ZZ } from "FreshCryptoLib/FCL_elliptic.sol";
import { Base64Url } from "FreshCryptoLib/utils/Base64Url.sol";
import { Test, Vm, console } from "forge-std/Test.sol";

import { DeployJustanAccount } from "../../script/DeployJustanAccount.s.sol";
import { HelperConfig } from "../../script/HelperConfig.s.sol";
import { CodeConstants } from "../../script/HelperConfig.s.sol";
import { JustanAccount } from "../../src/JustanAccount.sol";
import { JustanAccountFactory } from "../../src/JustanAccountFactory.sol";
import { MultiOwnable } from "../../src/MultiOwnable.sol";

/**
 * @title TestCrossChainValidation
 * @notice Unit tests for cross-chain validation, nonce key enforcement, and getUserOpHashWithoutChainId
 * @dev Tests the critical cross-chain replay functionality and signature validation
 */
contract TestCrossChainValidation is Test, CodeConstants {

    using MessageHashUtils for bytes32;

    JustanAccount public justanAccount;
    JustanAccountFactory public factory;
    JustanAccount public account;
    HelperConfig.NetworkConfig public networkConfig;

    address public owner;
    uint256 public ownerPk;

    // WebAuthn test data
    uint256 passkeyPrivateKey = uint256(0x03d99692017473e2d631945a812607b23269d85721e0f370b8d3e7d29a874fd2);
    bytes passkeyOwner =
        hex"1c05286fe694493eae33312f2d2e0d0abeda8db76238b7a204be1fb87f54ce4228fef61ef4ac300f631657635c28e59bfb2fe71bce1634c81c65642042f6dc4d";

    function setUp() public {
        // Deploy P256 verifier for WebAuthn tests
        vm.etch(P256.RIP_PRECOMPILE, P256_VERIFIER_BYTECODE);
        vm.etch(P256.VERIFIER, P256_VERIFIER_BYTECODE);

        DeployJustanAccount deployer = new DeployJustanAccount();
        (justanAccount, factory, networkConfig) = deployer.run();

        // TODO: use TEST_ACCOUNT_ADDRESS from code constants
        // Create an account with an initial owner for testing
        (owner, ownerPk) = makeAddrAndKey("owner");
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(owner);
        account = factory.createAccount(owners, 0);

        // Fund the account for gas
        vm.deal(address(account), 10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                    NONCE KEY VALIDATION TESTS
    //////////////////////////////////////////////////////////////*/
    function test_ShouldRevertWhenRegularExecuteUsesReplayableNonceKey(address newOwner) public {
        // Use replayable nonce key for a regular execute call
        uint256 replayableNonceKey = account.REPLAYABLE_NONCE_KEY();
        uint256 replayableNonce = (replayableNonceKey << 64) | 0;

        bytes memory callData = abi.encodeWithSelector(account.execute.selector, newOwner, 0, "");

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);
        bytes32 userOpHash = IEntryPoint(networkConfig.entryPointAddress).getUserOpHash(userOp);
        userOp.signature = _signUserOp(userOpHash, ownerPk);

        vm.expectRevert(
            abi.encodeWithSelector(JustanAccount.JustanAccount_InvalidNonceKey.selector, replayableNonceKey)
        );
        vm.prank(networkConfig.entryPointAddress);
        account.validateUserOp(userOp, userOpHash, 0);
    }

    function test_ShouldSucceedWhenExecuteWithoutChainIdValidationUsesReplayableNonceKey(address newOwner) public {
        // Use the correct replayable nonce key
        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, calls);

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);

        // Must use getUserOpHashWithoutChainId for cross-chain operations
        bytes32 userOpHash = account.getUserOpHashWithoutChainId(userOp);
        userOp.signature = _signUserOp(userOpHash, ownerPk);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_SUCCESS);
    }

    function test_ShouldSucceedWhenRegularExecuteUsesNonReplayableNonceKey(
        uint256 nonReplayableNonceKey,
        address newOwner
    )
        public
    {
        // Ensure it's not the replayable nonce key
        vm.assume(nonReplayableNonceKey != account.REPLAYABLE_NONCE_KEY());
        vm.assume(nonReplayableNonceKey < (1 << 192)); // Must fit in upper 192 bits

        uint256 nonReplayableNonce = (nonReplayableNonceKey << 64) | 0;

        bytes memory callData = abi.encodeWithSelector(account.execute.selector, newOwner, 0, "");

        PackedUserOperation memory userOp = _createUserOp(address(account), nonReplayableNonce, callData, false);
        bytes32 userOpHash = IEntryPoint(networkConfig.entryPointAddress).getUserOpHash(userOp);
        userOp.signature = _signUserOp(userOpHash, ownerPk);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, userOpHash, 0);

        assertEq(validationData, SIG_VALIDATION_SUCCESS);
    }

    function test_ShouldRevertWithNonReplayableNonceKeyForCrossChain(
        uint256 nonReplayableNonceKey,
        address newOwner
    )
        public
    {
        // Ensure it's not the replayable nonce key
        vm.assume(nonReplayableNonceKey != account.REPLAYABLE_NONCE_KEY());
        vm.assume(nonReplayableNonceKey < (1 << 192)); // Must fit in upper 192 bits

        uint256 nonReplayableNonce = (nonReplayableNonceKey << 64) | 0;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, calls);

        PackedUserOperation memory userOp = _createUserOp(address(account), nonReplayableNonce, callData, false);
        bytes32 userOpHash = IEntryPoint(networkConfig.entryPointAddress).getUserOpHash(userOp);
        userOp.signature = _signUserOp(userOpHash, ownerPk);

        vm.prank(networkConfig.entryPointAddress);
        vm.expectRevert(
            abi.encodeWithSelector(JustanAccount.JustanAccount_InvalidNonceKey.selector, nonReplayableNonceKey)
        );
        account.validateUserOp(userOp, userOpHash, 0);
    }

    /*//////////////////////////////////////////////////////////////
                getUserOpHashWithoutChainId TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldComputeHashWithoutChainId() public view {
        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, new bytes[](0));

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);
        bytes32 hashWithoutChainId = account.getUserOpHashWithoutChainId(userOp);

        // The hash should be deterministic
        bytes32 hashWithoutChainId2 = account.getUserOpHashWithoutChainId(userOp);
        assertEq(hashWithoutChainId, hashWithoutChainId2);

        // Verify it's a valid hash (non-zero)
        assertTrue(hashWithoutChainId != bytes32(0));
    }

    function test_ShouldComputeDifferentHashThanRegularUserOpHash() public view {
        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, new bytes[](0));

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);

        bytes32 regularHash = IEntryPoint(networkConfig.entryPointAddress).getUserOpHash(userOp);
        bytes32 crossChainHash = account.getUserOpHashWithoutChainId(userOp);

        // The hashes should be different (one includes chain ID, one doesn't)
        assertTrue(regularHash != crossChainHash);
    }

    function test_ShouldProduceSameHashOnDifferentChains() public {
        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, new bytes[](0));

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);

        // Compute hash on current chain
        bytes32 hashChain1 = account.getUserOpHashWithoutChainId(userOp);

        // Change to a different chain ID
        vm.chainId(999);
        bytes32 hashChain2 = account.getUserOpHashWithoutChainId(userOp);

        // Change to another chain ID
        vm.chainId(1);
        bytes32 hashChain3 = account.getUserOpHashWithoutChainId(userOp);

        // All hashes should be identical (chain ID is set to 0 in the hash)
        assertEq(hashChain1, hashChain2);
        assertEq(hashChain2, hashChain3);
    }

    function test_ShouldProduceDifferentHashesForDifferentCallData(address owner1, address owner2) public view {
        vm.assume(owner1 != owner2);

        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;

        bytes[] memory calls1 = new bytes[](1);
        calls1[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, owner1);
        bytes memory callData1 = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, calls1);

        bytes[] memory calls2 = new bytes[](1);
        calls2[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, owner2);
        bytes memory callData2 = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, calls2);

        PackedUserOperation memory userOp1 = _createUserOp(address(account), replayableNonce, callData1, false);
        PackedUserOperation memory userOp2 = _createUserOp(address(account), replayableNonce, callData2, false);

        bytes32 hash1 = account.getUserOpHashWithoutChainId(userOp1);
        bytes32 hash2 = account.getUserOpHashWithoutChainId(userOp2);

        assertTrue(hash1 != hash2);
    }

    /*//////////////////////////////////////////////////////////////
            CROSS-CHAIN SIGNATURE REPLAY TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateSameSignatureAcrossChains(address newOwner) public {
        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, calls);

        // Create and sign UserOp on chain 1
        vm.chainId(1);
        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);
        bytes32 crossChainHash = account.getUserOpHashWithoutChainId(userOp);
        userOp.signature = _signUserOp(crossChainHash, ownerPk);

        // Validate on chain 1
        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData1 = account.validateUserOp(userOp, crossChainHash, 0);
        assertEq(validationData1, SIG_VALIDATION_SUCCESS);

        // Switch to chain 999 and validate the SAME signature
        vm.chainId(999);
        bytes32 crossChainHash2 = account.getUserOpHashWithoutChainId(userOp);

        // Hash should be the same
        assertEq(crossChainHash, crossChainHash2);

        // Signature should still be valid
        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData2 = account.validateUserOp(userOp, crossChainHash2, 0);
        assertEq(validationData2, SIG_VALIDATION_SUCCESS);

        // Switch to chain 42161 (Arbitrum) and validate again
        vm.chainId(42_161);
        bytes32 crossChainHash3 = account.getUserOpHashWithoutChainId(userOp);
        assertEq(crossChainHash, crossChainHash3);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData3 = account.validateUserOp(userOp, crossChainHash3, 0);
        assertEq(validationData3, SIG_VALIDATION_SUCCESS);
    }

    function test_ShouldFailWithWrongSignature(address newOwner) public {
        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, calls);

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);
        bytes32 crossChainHash = account.getUserOpHashWithoutChainId(userOp);

        // Sign with wrong private key
        (, uint256 wrongPk) = makeAddrAndKey("wrongSigner");
        userOp.signature = _signUserOp(crossChainHash, wrongPk);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, crossChainHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldFailWithTamperedCalldata(address newOwner, address attacker) public {
        vm.assume(attacker != newOwner);

        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        bytes memory callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, calls);

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);
        bytes32 crossChainHash = account.getUserOpHashWithoutChainId(userOp);
        userOp.signature = _signUserOp(crossChainHash, ownerPk);

        // Tamper with the calldata after signing
        bytes[] memory tamperedCalls = new bytes[](1);
        tamperedCalls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, attacker);
        userOp.callData = abi.encodeWithSelector(account.executeWithoutChainIdValidation.selector, tamperedCalls);

        // Recompute hash with tampered data
        bytes32 tamperedHash = account.getUserOpHashWithoutChainId(userOp);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData = account.validateUserOp(userOp, tamperedHash, 0);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ShouldRevertWhenValidateUserOpNotCalledByEntryPointFuzzed(address caller, address newOwner) public {
        vm.assume(caller != networkConfig.entryPointAddress);

        uint256 replayableNonce = (account.REPLAYABLE_NONCE_KEY() << 64) | 0;
        bytes memory callData = abi.encodeWithSelector(account.execute.selector, newOwner, 0, "");

        PackedUserOperation memory userOp = _createUserOp(address(account), replayableNonce, callData, false);
        bytes32 userOpHash = IEntryPoint(networkConfig.entryPointAddress).getUserOpHash(userOp);
        userOp.signature = _signUserOp(userOpHash, ownerPk);

        vm.expectRevert("account: not from EntryPoint");
        vm.prank(caller);
        account.validateUserOp(userOp, userOpHash, 0);
    }

    /*//////////////////////////////////////////////////////////////
                    EIP-7702 SPECIFIC TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateCrossChainSignatureInEIP7702Mode(address newOwner) public {
        // Setup EIP-7702 delegation
        vm.signAndAttachDelegation(address(justanAccount), TEST_ACCOUNT_PRIVATE_KEY);

        uint256 replayableNonce = (justanAccount.REPLAYABLE_NONCE_KEY() << 64) | 0;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        bytes memory callData = abi.encodeWithSelector(justanAccount.executeWithoutChainIdValidation.selector, calls);

        // Sign on chain 1
        vm.chainId(1);
        PackedUserOperation memory userOp = _createUserOp(TEST_ACCOUNT_ADDRESS, replayableNonce, callData, true);
        bytes32 crossChainHash = JustanAccount(TEST_ACCOUNT_ADDRESS).getUserOpHashWithoutChainId(userOp);

        // Sign with the delegated account's key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_ACCOUNT_PRIVATE_KEY, crossChainHash);
        userOp.signature = abi.encodePacked(r, s, v);

        // Validate on chain 1
        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData1 = JustanAccount(TEST_ACCOUNT_ADDRESS).validateUserOp(userOp, crossChainHash, 0);
        assertEq(validationData1, SIG_VALIDATION_SUCCESS);

        // Validate on chain 10 (Optimism)
        vm.chainId(10);
        bytes32 crossChainHash2 = JustanAccount(TEST_ACCOUNT_ADDRESS).getUserOpHashWithoutChainId(userOp);
        assertEq(crossChainHash, crossChainHash2);

        vm.prank(networkConfig.entryPointAddress);
        uint256 validationData2 = JustanAccount(TEST_ACCOUNT_ADDRESS).validateUserOp(userOp, crossChainHash2, 0);
        assertEq(validationData2, SIG_VALIDATION_SUCCESS);
    }

    /*//////////////////////////////////////////////////////////////
                    WEBAUTHN SUPPORT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_ShouldValidateCrossChainWebAuthnSignature(address newOwner) public {
        // Create account with WebAuthn owner
        bytes[] memory owners = new bytes[](1);
        owners[0] = passkeyOwner;
        JustanAccount passkeyAccount = factory.createAccount(owners, 123);
        vm.deal(address(passkeyAccount), 10 ether);

        uint256 replayableNonce = (passkeyAccount.REPLAYABLE_NONCE_KEY() << 64) | 0;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(MultiOwnable.addOwnerAddress.selector, newOwner);
        bytes memory callData = abi.encodeWithSelector(passkeyAccount.executeWithoutChainIdValidation.selector, calls);

        // Create UserOp on chain 1
        vm.chainId(1);
        PackedUserOperation memory userOp = _createUserOp(address(passkeyAccount), replayableNonce, callData, false);
        bytes32 crossChainHash = passkeyAccount.getUserOpHashWithoutChainId(userOp);

        // Sign with WebAuthn
        userOp.signature = _signWebAuthn(crossChainHash, passkeyPrivateKey, 0);

        address passkeyAccountEntryPoint = address(passkeyAccount.entryPoint());

        // Validate on chain 1
        vm.prank(passkeyAccountEntryPoint);
        uint256 validationData1 = passkeyAccount.validateUserOp(userOp, crossChainHash, 0);
        assertEq(validationData1, SIG_VALIDATION_SUCCESS);

        // Validate on chain 8453 (Base)
        vm.chainId(8453);
        bytes32 crossChainHash2 = passkeyAccount.getUserOpHashWithoutChainId(userOp);
        assertEq(crossChainHash, crossChainHash2);

        vm.prank(passkeyAccountEntryPoint);
        uint256 validationData2 = passkeyAccount.validateUserOp(userOp, crossChainHash2, 0);
        assertEq(validationData2, SIG_VALIDATION_SUCCESS);
    }

    /*//////////////////////////////////////////////////////////////
                        HELPER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _createUserOp(
        address sender,
        uint256 nonce,
        bytes memory callData,
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

    function _signUserOp(bytes32 userOpHash, uint256 privateKey) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, userOpHash);
        bytes memory ecdsaSignature = abi.encodePacked(r, s, v);

        // Wrap the signature for factory accounts (owner at index 0)
        return abi.encode(JustanAccount.SignatureWrapper({ ownerIndex: 0, signatureData: ecdsaSignature }));
    }

    function _signWebAuthn(
        bytes32 challenge,
        uint256 privateKey,
        uint256 ownerIndex
    )
        internal
        view
        returns (bytes memory)
    {
        bytes memory challengeBytes = abi.encode(challenge);
        string memory challengeb64url = Base64Url.encode(challengeBytes);
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

        (bytes32 r, bytes32 s) = vm.signP256(privateKey, messageHash);
        s = bytes32(_normalizeS(uint256(s)));

        return abi.encode(
            JustanAccount.SignatureWrapper({
                ownerIndex: ownerIndex,
                signatureData: abi.encode(
                    WebAuthn.WebAuthnAuth({
                        authenticatorData: authenticatorData,
                        clientDataJSON: clientDataJSON,
                        typeIndex: 1,
                        challengeIndex: 23,
                        r: r,
                        s: s
                    })
                )
            })
        );
    }

    function _normalizeS(uint256 s) internal pure returns (uint256) {
        uint256 P256_N_DIV_2 = FCL_Elliptic_ZZ.n / 2;
        if (s > P256_N_DIV_2) {
            return FCL_Elliptic_ZZ.n - s;
        }
        return s;
    }

}
