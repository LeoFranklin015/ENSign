// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";

import {
    ENSignAgentRegistry,
    IVerifiableFactoryLite
} from "../src/ENSignAgentRegistry.sol";

/// @notice Deploys a fresh ENSignAgentRegistry against the ENSv2 staging
///         deployment tagged `sepolia-official-v1-20260525-r2`. The user-storage
///         proxy only exists after DeployENSignV2 runs, so it's passed via env:
///
///   USER_STORAGE_REGISTRY=0x... PRIVATE_KEY=0x... forge script \
///     script/DeployAgentRegistryV2.s.sol:DeployAgentRegistryV2 \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast -vv
contract DeployAgentRegistryV2 is Script {
    // ─── sepolia-official-v1-20260525-r2 ───
    address internal constant CANONICAL_USER_REGISTRY_IMPL =
        0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917;
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL =
        0xdcE5205A553573FFd47629327DDdf36186022FfA;
    address internal constant CANONICAL_VERIFIABLE_FACTORY =
        0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198;

    function run() external returns (address manager) {
        address userStorageRegistry = vm.envAddress("USER_STORAGE_REGISTRY");
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);
        manager = address(
            new ENSignAgentRegistry(
                PermissionedRegistry(userStorageRegistry),
                CANONICAL_USER_REGISTRY_IMPL,
                CANONICAL_PERMISSIONED_RESOLVER_IMPL,
                IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY)
            )
        );
        vm.stopBroadcast();

        console2.log("ENSignAgentRegistry  ", manager);
        console2.log("user storage registry", userStorageRegistry);
    }
}
