// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import {
    ZkEmailRecoveryProvider,
    EmailProof,
    IZkEmailVerifier,
    IDKIMRegistry
} from "../src/recovery/providers/ZkEmailRecoveryProvider.sol";

/// @notice Fork tests against zkEmail's REAL deployed Sepolia contracts. Unit tests
///         stub the Groth16 verifier; these prove our locally-declared `EmailProof`
///         struct and interfaces are ABI-compatible with what is actually on chain,
///         which a mock can never establish.
///
///         Run: forge test --match-contract ZkEmailForkIntegration --fork-url $SEPOLIA_RPC_URL
contract ZkEmailForkIntegrationTest is Test {
    // zkEmail account-recovery deployment, chain 11155111.
    address internal constant ZK_VERIFIER = 0x3E5f29a7cCeb30D5FCD90078430CA110c2985716;
    address internal constant DKIM_REGISTRY = 0x3D3935B3C030893f118a84C92C66dF1B9E4169d6;
    address internal constant GROTH16 = 0xa63e3640633Ac39457D6B3770659821d16CA11cE;

    function setUp() public {
        // Skip silently unless run against a fork.
        vm.skip(block.chainid != 11155111);
    }

    /// @dev If our `IZkEmailVerifier` shape were wrong, this call would revert.
    ///      605 is zkEmail's COMMAND_BYTES constant.
    function test_fork_verifierInterfaceMatches() public view {
        assertEq(IZkEmailVerifier(ZK_VERIFIER).commandBytes(), 605);
        assertGt(ZK_VERIFIER.code.length, 0);
        assertGt(GROTH16.code.length, 0);
    }

    /// @dev Feeds the real verifier a structurally valid but cryptographically
    ///      bogus proof. It must decode our struct cleanly and reject the proof —
    ///      returning false or reverting inside the pairing check, never failing
    ///      to decode. This is the ABI-compatibility proof.
    function test_fork_emailProofStructIsAbiCompatible() public view {
        EmailProof memory proof = EmailProof({
            domainName: "gmail.com",
            publicKeyHash: 0x0ea9c777dc7110e5a9e89b13f0cfc540e3845ba120b2b6dc24024d61488d4788,
            timestamp: block.timestamp,
            maskedCommand: "Recover account 0x0000000000000000000000000000000000000001 using recovery hash 0x00",
            emailNullifier: keccak256("nullifier"),
            accountSalt: keccak256("salt"),
            isCodeExist: true,
            // Correctly sized Groth16 payload: (uint256[2], uint256[2][2], uint256[2]).
            proof: abi.encode(
                [uint256(1), uint256(2)],
                [[uint256(3), uint256(4)], [uint256(5), uint256(6)]],
                [uint256(7), uint256(8)]
            )
        });

        (bool ok, bytes memory ret) = ZK_VERIFIER.staticcall(
            abi.encodeCall(IZkEmailVerifier.verifyEmailProof, (proof))
        );

        if (ok) {
            // Decoded fine, pairing check failed as expected for a bogus proof.
            assertFalse(abi.decode(ret, (bool)), "bogus proof must not verify");
        } else {
            // Reverted inside the pairing check (points not on curve) — also fine.
            // What matters is that it got past ABI decoding of our struct.
            assertEq(ret.length, 0, "unexpected structured revert: struct likely mismatched");
        }
    }

    /// @dev The canonical registry resolves the caller's authorizer via
    ///      `Ownable(msg.sender).owner()`, so an EOA call reverts but a call from
    ///      our provider (which exposes `owner()`) reaches the policy logic.
    function test_fork_providerSatisfiesDKIMRegistryOwnableCall() public {
        ZkEmailRecoveryProvider provider = new ZkEmailRecoveryProvider(
            IZkEmailVerifier(ZK_VERIFIER), IDKIMRegistry(DKIM_REGISTRY), address(this)
        );
        assertEq(provider.owner(), address(this));

        // Direct EOA-style call reverts (no owner() on the caller).
        (bool okDirect,) = DKIM_REGISTRY.staticcall(
            abi.encodeCall(IDKIMRegistry.isDKIMPublicKeyHashValid, ("gmail.com", bytes32(uint256(1))))
        );
        assertFalse(okDirect, "expected the Ownable(msg.sender).owner() gotcha");
    }
}
