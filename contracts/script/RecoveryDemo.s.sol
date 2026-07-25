// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";

import {PermissionedRegistry} from "@ensv2/registry/PermissionedRegistry.sol";
import {UserRegistry} from "@ensv2/registry/UserRegistry.sol";
import {IRegistry} from "@ensv2/registry/interfaces/IRegistry.sol";
import {EACBaseRolesLib} from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";

import {SmartAccount} from "../src/account/SmartAccount.sol";
import {SmartAccountFactory} from "../src/account/SmartAccountFactory.sol";
import {ENSignRecoveryManager} from "../src/recovery/ENSignRecoveryManager.sol";
import {ENSRecoveryProvider} from "../src/recovery/providers/ENSRecoveryProvider.sol";
import {Addresses} from "./Addresses.sol";

interface IVerifiableFactoryLite {
    function deployProxy(address impl, uint256 salt, bytes calldata data) external returns (address);
}

/// @notice End-to-end recovery lifecycle against the live ensign.eth Sepolia stack:
///
///   1. Creates a fresh EOA-owned SmartAccount (script-drivable stand-in for a
///      passkey account) and mints `rec<timestamp>.ensign.eth` for it.
///   2. Builds the recovery namespace: per-user registry, `recovery` subname, a
///      canonical methods proxy, and two guardian subnames (`mom`, `ghadi`) —
///      all indexed on explorer.ens.dev.
///   3. Opts the account into the ENSignRecoveryManager, registers both guardians
///      as ENS-committed recoveries (threshold 2, delay 0 for the live demo).
///   4. Guardians sign EIP-712 approvals for a brand-new passkey; anyone submits
///      `requestRecovery`, then `executeRecoveryRequest` installs the key.
///   5. Asserts the account now recognises the new passkey owner.
///
/// Env: PRIVATE_KEY (deployer w/ registrar roles) or SENDER (simulation);
///      RECOVERY_MANAGER / ENS_PROVIDER optional (deployed inline when unset).
contract RecoveryDemo is Script {
    // sepolia-official-v1-20260525-r2 stack
    address internal constant USER_STORAGE_REGISTRY = 0x674cBe3246596871f18B2fe3489E09D77734fE06;
    address internal constant CANONICAL_USER_REGISTRY_IMPL = 0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917;
    address internal constant CANONICAL_VERIFIABLE_FACTORY = 0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198;
    address internal constant SMART_ACCOUNT_FACTORY = 0x5803c076563C85799989d42Fc00292A8aE52fa9E;

    bytes32 internal constant NEW_QX = keccak256("recovered-device-qx");
    bytes32 internal constant NEW_QY = keccak256("recovered-device-qy");

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : vm.envAddress("SENDER");
        string memory userLabel = string.concat("rec", vm.toString(block.timestamp));
        uint64 expiry = uint64(block.timestamp + 365 days);

        Vm.Wallet memory mom = vm.createWallet(uint256(keccak256(abi.encode("mom", block.timestamp))));
        Vm.Wallet memory ghadi = vm.createWallet(uint256(keccak256(abi.encode("ghadi", block.timestamp))));

        console2.log("=== ENSign Recovery Demo ===");
        console2.log("deployer      ", deployer);
        console2.log("user label    ", userLabel);
        console2.log("guardian mom  ", mom.addr);
        console2.log("guardian ghadi", ghadi.addr);

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast(deployer);

        // ─── 0. Engine (reuse if provided, else deploy) ───
        ENSignRecoveryManager manager = ENSignRecoveryManager(vm.envOr("RECOVERY_MANAGER", address(0)));
        ENSRecoveryProvider ensProvider = ENSRecoveryProvider(vm.envOr("ENS_PROVIDER", address(0)));
        if (address(manager) == address(0)) manager = new ENSignRecoveryManager();
        if (address(ensProvider) == address(0)) ensProvider = new ENSRecoveryProvider();

        // ─── 1. Fresh EOA-owned smart account + its ENS name ───
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(deployer);
        SmartAccount account = SmartAccountFactory(SMART_ACCOUNT_FACTORY).createAccount(
            owners, uint256(keccak256(abi.encode(userLabel, deployer)))
        );
        uint256 userTokenId = PermissionedRegistry(USER_STORAGE_REGISTRY).register(
            userLabel, address(account), IRegistry(address(0)), address(0),
            EACBaseRolesLib.ALL_ROLES, expiry
        );

        // ─── 2. Recovery namespace: user registry -> "recovery" -> methods proxy ───
        address userNamespace = IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY).deployProxy(
            CANONICAL_USER_REGISTRY_IMPL,
            uint256(keccak256(abi.encode("rec-namespace", userLabel, deployer))),
            abi.encodeCall(UserRegistry.initialize, (deployer, EACBaseRolesLib.ALL_ROLES))
        );
        address methodsProxy = IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY).deployProxy(
            CANONICAL_USER_REGISTRY_IMPL,
            uint256(keccak256(abi.encode("rec-methods", userLabel, deployer))),
            abi.encodeCall(UserRegistry.initialize, (deployer, EACBaseRolesLib.ALL_ROLES))
        );
        // The account owns its name, so IT re-points the subregistry (driven by its owner EOA).
        account.execute(
            USER_STORAGE_REGISTRY, 0,
            abi.encodeCall(PermissionedRegistry.setSubregistry, (userTokenId, IRegistry(userNamespace)))
        );
        PermissionedRegistry(userNamespace).register(
            "recovery", address(account), IRegistry(methodsProxy), address(0),
            EACBaseRolesLib.ALL_ROLES, expiry
        );

        // ─── 3. Guardian subnames (indexed: mom.recovery.<user>.ensign.eth) ───
        uint256 momToken = PermissionedRegistry(methodsProxy).register(
            "mom", mom.addr, IRegistry(address(0)), address(0), EACBaseRolesLib.ALL_ROLES, expiry
        );
        uint256 ghadiToken = PermissionedRegistry(methodsProxy).register(
            "ghadi", ghadi.addr, IRegistry(address(0)), address(0), EACBaseRolesLib.ALL_ROLES, expiry
        );
        uint256 momResource = PermissionedRegistry(methodsProxy).getResource(momToken);
        uint256 ghadiResource = PermissionedRegistry(methodsProxy).getResource(ghadiToken);

        // ─── 4. Opt in + register both guardians as recoveries (2-of-2, delay 0 for demo) ───
        account.addOwnerAddress(address(manager)); // caller is an owner of the account
        bytes memory momCommitment = abi.encode(methodsProxy, momResource);
        bytes memory ghadiCommitment = abi.encode(methodsProxy, ghadiResource);
        account.execute(address(manager), 0,
            abi.encodeCall(ENSignRecoveryManager.addRecovery, (address(ensProvider), momCommitment, 0)));
        account.execute(address(manager), 0,
            abi.encodeCall(ENSignRecoveryManager.addRecovery, (address(ensProvider), ghadiCommitment, 0)));
        account.execute(address(manager), 0,
            abi.encodeCall(ENSignRecoveryManager.setRecoveryThreshold, (2)));

        // ─── 5. The user "loses their device": guardians sign for the new passkey ───
        bytes memory subject = abi.encode(NEW_QX, NEW_QY);
        uint256 nonce = manager.recoveryNonce(address(account));
        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](2);
        approvals[0] = ENSignRecoveryManager.Approval(
            manager.computeRecoveryId(address(account), address(ensProvider), momCommitment),
            _signApproval(mom.privateKey, address(ensProvider), address(account), nonce, subject)
        );
        approvals[1] = ENSignRecoveryManager.Approval(
            manager.computeRecoveryId(address(account), address(ensProvider), ghadiCommitment),
            _signApproval(ghadi.privateKey, address(ensProvider), address(account), nonce, subject)
        );

        bytes32 requestId = manager.requestRecovery(address(account), subject, approvals);
        manager.executeRecoveryRequest(requestId);

        vm.stopBroadcast();

        require(account.isOwnerPublicKey(NEW_QX, NEW_QY), "recovery failed: new passkey not installed");

        console2.log("");
        console2.log("recovered! new passkey is now an owner of", address(account));
        console2.log("manager        ", address(manager));
        console2.log("ens provider   ", address(ensProvider));
        console2.log("explorer:");
        console2.log(string.concat("  https://explorer.ens.dev/", userLabel, ".ensign.eth/subnames"));
        console2.log(string.concat("  mom.recovery.", userLabel, ".ensign.eth"));
        console2.log(string.concat("  ghadi.recovery.", userLabel, ".ensign.eth"));
    }

    /// @dev EIP-712 signature over Recover(account, nonce, subject) in the provider's domain.
    function _signApproval(
        uint256 guardianPk,
        address provider,
        address account,
        uint256 nonce,
        bytes memory subject
    ) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ENSRecoveryProvider")),
                keccak256(bytes("1")),
                block.chainid,
                provider
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Recover(address account,uint256 nonce,bytes subject)"),
                account,
                nonce,
                keccak256(subject)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guardianPk, digest);
        return abi.encodePacked(r, s, v);
    }
}
