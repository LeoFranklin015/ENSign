// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {UserRegistry} from "@ensv2/registry/UserRegistry.sol";
import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensv2/registry/libraries/RegistryRolesLib.sol";
import {EACBaseRolesLib} from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";
import {LibLabel} from "@ensv2/utils/LibLabel.sol";

import {
    ENSignRegistry,
    IUserRegistry,
    ISmartAccountFactory,
    IVerifiableFactoryLite
} from "../src/ENSignRegistry.sol";
import {Addresses} from "./Addresses.sol";

interface IVerifiableFactoryFull {
    function deployProxy(address impl, uint256 salt, bytes calldata data) external returns (address);
    function verifyContract(address proxy) external view returns (bool);
}

/// @notice Deploys the wrapper-shaped ENSign stack on the active chain:
///   1. Canonical-impl `UserRegistry` proxy via `VerifiableFactory` (indexer-recognised).
///   2. `ENSignRegistry` developer-facing wrapper.
///   3. Grants `ROLE_REGISTRAR` to the wrapper on the storage registry.
///   4. Re-points `ensign.eth`'s subregistry on the canonical `.eth` registry to the
///      storage registry (NOT the wrapper) so the indexer walks into a recognised impl.
contract DeployENSign is Script {
    address internal constant FACTORY = 0xb9541BDD86C4D01C726A33694f14e8528AdCb20d;
    address internal constant CANONICAL_USER_REGISTRY_IMPL =
        0x8CFbF4a6B3F546021b9F8e6099bdA2Cb0297cd25;
    /// @dev `0xa20B41dC…59c46` is canonical but a read-only L2 mirror on L1 — `setAddr`
    ///      reverts because writes happen on Namechain. We use our previously-deployed
    ///      writable `PermissionedResolver` impl. Indexer subname listings come from the
    ///      canonical `UserRegistry`'s `TransferSingle` event, so subnames still appear.
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL =
        0x4a333a4f95eB799baC5446CA44301C09cc5AbcDe;
    address internal constant ETH_REGISTRY = 0xF332544e6234f1CA149907D0d4658afD5feB6831;
    address internal constant SMART_ACCOUNT_FACTORY = 0x5803c076563C85799989d42Fc00292A8aE52fa9E;

    function run()
        external
        returns (address storageProxy, address jcr)
    {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 salt = uint256(
            keccak256(abi.encode("justaconnect-storage", deployer, block.timestamp))
        );
        bytes32 parentNode = Addresses.parentNode();
        uint256 parentTokenId = PermissionedRegistry(ETH_REGISTRY).getTokenId(
            LibLabel.id(Addresses.PARENT_LABEL)
        );

        console2.log("deployer        ", deployer);
        console2.log("parent label    ", Addresses.PARENT_LABEL);
        console2.log("parent tokenId  ", parentTokenId);

        vm.startBroadcast(pk);

        // 1. Canonical UserRegistry proxy. Initialised with deployer = admin holding ALL_ROLES so
        //    we can grant ROLE_REGISTRAR to the wrapper next.
        bytes memory initData = abi.encodeCall(
            UserRegistry.initialize,
            (deployer, EACBaseRolesLib.ALL_ROLES)
        );
        storageProxy = IVerifiableFactoryFull(FACTORY).deployProxy(
            CANONICAL_USER_REGISTRY_IMPL,
            salt,
            initData
        );

        // 2. Wrapper.
        ENSignRegistry wrapper = new ENSignRegistry(
            IUserRegistry(storageProxy),
            ISmartAccountFactory(SMART_ACCOUNT_FACTORY),
            IVerifiableFactoryLite(FACTORY),
            CANONICAL_PERMISSIONED_RESOLVER_IMPL,
            parentNode,
            deployer
        );
        jcr = address(wrapper);

        // 3. Grant ROLE_REGISTRAR on the storage registry to the wrapper. The wrapper's
        //    register() calls storageRegistry.register() which checks ROLE_REGISTRAR.
        IUserRegistry(storageProxy).grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR,
            jcr
        );

        // 4. Re-point parent's subregistry → storage proxy. Self-grant SET_SUBREGISTRY first;
        //    a no-op if we already hold it from earlier wiring.
        try
            PermissionedRegistry(ETH_REGISTRY).grantRoles(
                parentTokenId,
                RegistryRolesLib.ROLE_SET_SUBREGISTRY,
                deployer
            )
        returns (bool) {} catch {}
        PermissionedRegistry(ETH_REGISTRY).setSubregistry(parentTokenId, IRegistry(storageProxy));

        vm.stopBroadcast();

        console2.log("storageProxy    ", storageProxy);
        console2.log("wrapper (JCR)   ", jcr);
        console2.log(
            "verifyStorage   ",
            IVerifiableFactoryFull(FACTORY).verifyContract(storageProxy) ? "true" : "false"
        );
        console2.log(
            "subregistry now ",
            address(PermissionedRegistry(ETH_REGISTRY).getSubregistry(Addresses.PARENT_LABEL))
        );
    }
}
