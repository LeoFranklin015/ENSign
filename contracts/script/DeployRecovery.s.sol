// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {ENSignRecoveryManager} from "../src/recovery/ENSignRecoveryManager.sol";
import {ENSRecoveryProvider} from "../src/recovery/providers/ENSRecoveryProvider.sol";
import {ECDSARecoveryProvider} from "../src/recovery/providers/ECDSARecoveryProvider.sol";
import {
    ZkEmailRecoveryProvider,
    IZkEmailVerifier,
    IDKIMRegistry
} from "../src/recovery/providers/ZkEmailRecoveryProvider.sol";

/// @notice Deploys the ENSign recovery engine: the singleton manager plus the launch
///         providers. All are non-ownable and constructor-only — no wiring, no roles,
///         no follow-up transactions.
contract DeployRecovery is Script {
    /// @dev zkEmail's account-recovery deployment on Sepolia (chain 11155111).
    address internal constant ZK_VERIFIER = 0x3E5f29a7cCeb30D5FCD90078430CA110c2985716;
    address internal constant ZK_DKIM_REGISTRY = 0x3D3935B3C030893f118a84C92C66dF1B9E4169d6;

    function run()
        external
        returns (address manager, address ensProvider, address ecdsaProvider, address zkEmailProvider)
    {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");
        // Authorizer reported as the provider's `owner()` to DKIM registries that
        // resolve `Ownable(msg.sender).owner()`.
        address dkimAuthorizer = vm.envOr("DKIM_AUTHORIZER", deployer);

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);

        manager = address(new ENSignRecoveryManager());
        ensProvider = address(new ENSRecoveryProvider());
        ecdsaProvider = address(new ECDSARecoveryProvider());
        zkEmailProvider = address(
            new ZkEmailRecoveryProvider(
                IZkEmailVerifier(ZK_VERIFIER), IDKIMRegistry(ZK_DKIM_REGISTRY), dkimAuthorizer
            )
        );

        vm.stopBroadcast();

        console2.log("ENSignRecoveryManager  ", manager);
        console2.log("ENSRecoveryProvider    ", ensProvider);
        console2.log("ECDSARecoveryProvider  ", ecdsaProvider);
        console2.log("ZkEmailRecoveryProvider", zkEmailProvider);
    }
}
