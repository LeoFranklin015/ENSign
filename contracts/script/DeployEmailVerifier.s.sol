// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {Groth16Verifier} from "../src/recovery/zkemail/Groth16Verifier.sol";
import {EmailProofVerifier, IGroth16Verifier} from "../src/recovery/zkemail/EmailProofVerifier.sol";
import {
    ZkEmailRecoveryProvider,
    IZkEmailVerifier,
    IDKIMRegistry
} from "../src/recovery/providers/ZkEmailRecoveryProvider.sol";

/// @notice Deploys a verifier matching the `v2.0.2-dev` zkey our prover uses, plus
///         a `ZkEmailRecoveryProvider` bound to it.
///
///         zkEmail's own deployed verifiers reject proofs from this zkey (their
///         keys are from older circuit builds — confirmed against a real proof),
///         so recovery needs its own verifier. The DKIM registry stays theirs:
///         gmail.com's key is registered there and validates correctly.
contract DeployEmailVerifier is Script {
    address internal constant ZK_DKIM_REGISTRY = 0x3D3935B3C030893f118a84C92C66dF1B9E4169d6;

    function run()
        external
        returns (address groth16, address verifier, address provider)
    {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");
        address dkimAuthorizer = vm.envOr("DKIM_AUTHORIZER", deployer);

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);

        groth16 = address(new Groth16Verifier());
        verifier = address(new EmailProofVerifier(IGroth16Verifier(groth16)));
        provider = address(
            new ZkEmailRecoveryProvider(
                IZkEmailVerifier(verifier),
                IDKIMRegistry(ZK_DKIM_REGISTRY),
                dkimAuthorizer
            )
        );

        vm.stopBroadcast();

        console2.log("Groth16Verifier         ", groth16);
        console2.log("EmailProofVerifier      ", verifier);
        console2.log("ZkEmailRecoveryProvider ", provider);
    }
}
