// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {EACBaseRolesLib} from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";

import {Addresses} from "./Addresses.sol";

interface IPermissionedResolver {
    function setAddr(bytes32 node, uint256 coinType, bytes calldata addressBytes) external;
}

/// @notice Adds one entry to the live providers.ensign.eth catalog — the whole
///         "plug in a new recovery implementation" step, on-chain:
///
///           LABEL=email PROVIDER=0x... forge script ... --broadcast
///
///         mints `<LABEL>.providers.ensign.eth` with addr -> PROVIDER.
contract AddProviderToCatalog is Script {
    address internal constant CATALOG_REGISTRY = 0x91AC2d66EbF6a7Ac7017eA4DEa426e3f24e2dE5a;
    address internal constant CATALOG_RESOLVER = 0x9AA93685B4d6238F4035bdd21092901E80bbA01e;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");
        string memory label = vm.envString("LABEL");
        address provider = vm.envAddress("PROVIDER");
        uint64 expiry = uint64(block.timestamp + 365 days);

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);

        PermissionedRegistry(CATALOG_REGISTRY).register(
            label, deployer, IRegistry(address(0)), CATALOG_RESOLVER, EACBaseRolesLib.ALL_ROLES, expiry
        );

        bytes32 providersNode = _childNode(Addresses.parentNode(), keccak256(bytes("providers")));
        IPermissionedResolver(CATALOG_RESOLVER).setAddr(
            _childNode(providersNode, keccak256(bytes(label))), 60, abi.encodePacked(provider)
        );

        vm.stopBroadcast();

        console2.log(string.concat(label, ".providers.ensign.eth ->"), provider);
    }

    function _childNode(bytes32 parent, bytes32 labelHash) internal pure returns (bytes32 node) {
        assembly {
            mstore(0, parent)
            mstore(32, labelHash)
            node := keccak256(0, 64)
        }
    }
}
