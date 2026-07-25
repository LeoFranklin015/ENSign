// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";
import {UserRegistry} from "@ensv2/registry/UserRegistry.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {EACBaseRolesLib} from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";

import {Addresses} from "./Addresses.sol";

interface IVerifiableFactoryLite {
    function deployProxy(address impl, uint256 salt, bytes calldata data) external returns (address);
}

interface IPermissionedResolver {
    function initialize(address admin, uint256 roleBitmap) external;
    function setAddr(bytes32 node, uint256 coinType, bytes calldata addressBytes) external;
}

/// @notice One-time platform setup: publishes the recovery provider catalog as an
///         indexed ENS subtree.
///
///           providers.ensign.eth            (canonical proxy -> indexed)
///             ├── ens    -> addr: ENSRecoveryProvider
///             └── ecdsa  -> addr: ECDSARecoveryProvider
///
///         Discovery only, never enforcement: the manager stores provider addresses
///         at addRecovery time and never consults this tree.
///
/// Env: PRIVATE_KEY (or SENDER for simulation), ENS_PROVIDER, ECDSA_PROVIDER.
contract SetupProviderCatalog is Script {
    address internal constant USER_STORAGE_REGISTRY = 0x674cBe3246596871f18B2fe3489E09D77734fE06;
    address internal constant CANONICAL_USER_REGISTRY_IMPL = 0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917;
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL = 0xdcE5205A553573FFd47629327DDdf36186022FfA;
    address internal constant CANONICAL_VERIFIABLE_FACTORY = 0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198;

    function run() external returns (address catalog, address resolver) {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");
        address ensProvider = vm.envAddress("ENS_PROVIDER");
        address ecdsaProvider = vm.envAddress("ECDSA_PROVIDER");
        uint64 expiry = uint64(block.timestamp + 365 days);

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);

        // Catalog registry + a shared resolver for its entries.
        catalog = IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY).deployProxy(
            CANONICAL_USER_REGISTRY_IMPL,
            uint256(keccak256(abi.encode("providers-catalog", deployer))),
            abi.encodeCall(UserRegistry.initialize, (deployer, EACBaseRolesLib.ALL_ROLES))
        );
        resolver = IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY).deployProxy(
            CANONICAL_PERMISSIONED_RESOLVER_IMPL,
            uint256(keccak256(abi.encode("providers-resolver", deployer))),
            abi.encodeCall(IPermissionedResolver.initialize, (deployer, EACBaseRolesLib.ALL_ROLES))
        );

        // providers.ensign.eth, subregistry pointed at the catalog at mint.
        PermissionedRegistry(USER_STORAGE_REGISTRY).register(
            "providers", deployer, IRegistry(catalog), address(0), EACBaseRolesLib.ALL_ROLES, expiry
        );

        bytes32 providersNode = _childNode(Addresses.parentNode(), keccak256(bytes("providers")));
        _addEntry(catalog, resolver, providersNode, "ens", ensProvider, deployer, expiry);
        _addEntry(catalog, resolver, providersNode, "ecdsa", ecdsaProvider, deployer, expiry);

        vm.stopBroadcast();

        console2.log("catalog registry ", catalog);
        console2.log("catalog resolver ", resolver);
        console2.log("ens.providers.ensign.eth   ->", ensProvider);
        console2.log("ecdsa.providers.ensign.eth ->", ecdsaProvider);
    }

    function _addEntry(
        address catalog,
        address resolver,
        bytes32 providersNode,
        string memory label,
        address provider,
        address owner,
        uint64 expiry
    ) internal {
        PermissionedRegistry(catalog).register(
            label, owner, IRegistry(address(0)), resolver, EACBaseRolesLib.ALL_ROLES, expiry
        );
        IPermissionedResolver(resolver).setAddr(
            _childNode(providersNode, keccak256(bytes(label))), 60, abi.encodePacked(provider)
        );
    }

    function _childNode(bytes32 parent, bytes32 labelHash) internal pure returns (bytes32 node) {
        assembly {
            mstore(0, parent)
            mstore(32, labelHash)
            node := keccak256(0, 64)
        }
    }
}
