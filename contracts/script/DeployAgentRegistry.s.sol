// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";

import {
    ENSignAgentRegistry,
    IVerifiableFactoryLite
} from "../src/ENSignAgentRegistry.sol";

/// @notice Deploys a fresh ENSignAgentRegistry pointing at the ensign.eth user-storage proxy.
contract DeployAgentRegistry is Script {
    /// @dev ensign.eth user-storage proxy (canonical UserRegistry impl).
    address internal constant USER_STORAGE_REGISTRY =
        0x511b08f0358F042cA5cED53d7bd68F3f41cE740D;

    address internal constant CANONICAL_USER_REGISTRY_IMPL =
        0x8CFbF4a6B3F546021b9F8e6099bdA2Cb0297cd25;
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL =
        0x4a333a4f95eB799baC5446CA44301C09cc5AbcDe;
    address internal constant CANONICAL_VERIFIABLE_FACTORY =
        0xb9541BDD86C4D01C726A33694f14e8528AdCb20d;

    function run() external returns (address manager) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        manager = address(
            new ENSignAgentRegistry(
                PermissionedRegistry(USER_STORAGE_REGISTRY),
                CANONICAL_USER_REGISTRY_IMPL,
                CANONICAL_PERMISSIONED_RESOLVER_IMPL,
                IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY)
            )
        );
        vm.stopBroadcast();

        console2.log("ENSignAgentRegistry  ", manager);
        console2.log("user storage registry", USER_STORAGE_REGISTRY);
    }
}
