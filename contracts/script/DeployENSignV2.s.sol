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

interface IResolverReader {
    function addr(bytes32 node) external view returns (address);
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @notice Deploys the wrapper-shaped ENSign stack against the ENSv2 staging
///         deployment tagged `sepolia-official-v1-20260525-r2` (the one the
///         current docs point at). Same shape as DeployENSign.s.sol:
///   1. Canonical-impl `UserRegistry` proxy via the new `VerifiableFactory`.
///   2. `ENSignRegistry` developer-facing wrapper.
///   3. Grants `ROLE_REGISTRAR` to the wrapper on the storage registry.
///   4. Re-points `ensign.eth`'s subregistry on the new `ETHRegistry` to the
///      storage registry (NOT the wrapper).
///
/// Run modes:
///   broadcast:  PRIVATE_KEY=0x... forge script ... --broadcast
///   simulation: SENDER=0xE082... forge script ...          (no key needed)
///   SMOKE_TEST=true additionally registers a throwaway subname end-to-end,
///   exercising the resolver proxy deploy + setAddr/setText path.
contract DeployENSignV2 is Script {
    // ─── sepolia-official-v1-20260525-r2 ───
    address internal constant ETH_REGISTRY = 0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67;
    address internal constant FACTORY = 0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198;
    address internal constant CANONICAL_USER_REGISTRY_IMPL =
        0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917;
    /// @dev Canonical resolver impl of the new deployment. If setAddr still
    ///      reverts on L1 (the old "read-only mirror" trap), redeploy our own
    ///      writable impl and swap this constant.
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL =
        0xdcE5205A553573FFd47629327DDdf36186022FfA;
    address internal constant SMART_ACCOUNT_FACTORY = 0x5803c076563C85799989d42Fc00292A8aE52fa9E;

    function run()
        external
        returns (address storageProxy, address jcr)
    {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");
        uint256 salt = uint256(
            keccak256(abi.encode("ensign-storage-v2", deployer, block.timestamp))
        );
        bytes32 parentNode = Addresses.parentNode();
        uint256 parentTokenId = PermissionedRegistry(ETH_REGISTRY).getTokenId(
            LibLabel.id(Addresses.PARENT_LABEL)
        );

        console2.log("deployer        ", deployer);
        console2.log("parent label    ", Addresses.PARENT_LABEL);
        console2.log("parent tokenId  ", parentTokenId);
        console2.log("parent owner    ", PermissionedRegistry(ETH_REGISTRY).ownerOf(parentTokenId));

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);

        // 1. Canonical UserRegistry proxy, deployer = admin with ALL_ROLES.
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

        // 3. Wrapper needs ROLE_REGISTRAR on the storage registry.
        IUserRegistry(storageProxy).grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR,
            jcr
        );

        // 4. Re-point parent's subregistry -> storage proxy. Self-grant is a
        //    no-op if the deployer already holds SET_SUBREGISTRY from registration.
        try
            PermissionedRegistry(ETH_REGISTRY).grantRoles(
                parentTokenId,
                RegistryRolesLib.ROLE_SET_SUBREGISTRY,
                deployer
            )
        returns (bool) {} catch {}
        PermissionedRegistry(ETH_REGISTRY).setSubregistry(parentTokenId, IRegistry(storageProxy));

        // 5. Optional end-to-end smoke test: registers a throwaway subname,
        //    which exercises the resolver proxy deploy + setAddr + setText path
        //    and proves the canonical resolver impl is writable on L1.
        if (vm.envOr("SMOKE_TEST", false)) {
            string memory label = string.concat("smoke", vm.toString(block.timestamp));
            (uint256 tokenId, address account) = wrapper.register(
                label,
                keccak256("smoke-qx"),
                keccak256("smoke-qy"),
                "smoke-credential",
                uint64(block.timestamp + 30 days)
            );
            console2.log("smoke label     ", label);
            console2.log("smoke tokenId   ", tokenId);
            console2.log("smoke account   ", account);

            // Read-back through the exact path a dApp walks:
            // ETHRegistry -> subregistry("ensign") -> getResolver(label) -> addr/text.
            IRegistry sub = PermissionedRegistry(ETH_REGISTRY).getSubregistry(
                Addresses.PARENT_LABEL
            );
            require(address(sub) == storageProxy, "subregistry pointer mismatch");
            address rslv = IUserRegistry(address(sub)).getResolver(label);
            require(rslv != address(0), "resolver not set");
            bytes32 node = keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
            require(
                IResolverReader(rslv).addr(node) == account,
                "addr read-back mismatch"
            );
            require(
                keccak256(bytes(IResolverReader(rslv).text(node, "credentialId")))
                    == keccak256(bytes("smoke-credential")),
                "credentialId read-back mismatch"
            );
            console2.log("smoke resolver  ", rslv);
            console2.log("smoke read-back  addr + credentialId OK");
        }

        vm.stopBroadcast();

        console2.log("storageProxy    ", storageProxy);
        console2.log("wrapper (JCR)   ", jcr);
        // The 20260525-r2 VerifiableFactory dropped verifyContract(address);
        // keep the probe non-fatal in case a future deployment restores it.
        try IVerifiableFactoryFull(FACTORY).verifyContract(storageProxy) returns (bool ok) {
            console2.log("verifyStorage   ", ok ? "true" : "false");
        } catch {
            console2.log("verifyStorage    n/a (selector missing on this factory)");
        }
        console2.log(
            "subregistry now ",
            address(PermissionedRegistry(ETH_REGISTRY).getSubregistry(Addresses.PARENT_LABEL))
        );
    }
}
