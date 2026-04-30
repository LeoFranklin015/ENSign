// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";

import { VerifiableFactory } from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import { UserRegistry } from "@ensv2/registry/UserRegistry.sol";
import { PermissionedRegistry } from "@ensv2/registry/PermissionedRegistry.sol";
import { IRegistry } from "@ensv2/registry/interfaces/IRegistry.sol";
import { RegistryRolesLib } from "@ensv2/registry/libraries/RegistryRolesLib.sol";
import { EACBaseRolesLib } from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";
import { LibLabel } from "@ensv2/utils/LibLabel.sol";

import { SmartAccount } from "@account/SmartAccount.sol";
import { SmartAccountFactory } from "@account/SmartAccountFactory.sol";

import {
    ENSignAgentRegistry,
    IExecutable,
    IPermissionedResolver,
    IVerifiableFactoryLite
} from "../src/ENSignAgentRegistry.sol";

import { Addresses } from "./Addresses.sol";

/// @notice Toy ERC-20 minted to leoTest so we can exercise the spend-cap path.
contract DemoToken {
    string public constant name = "DemoToken";
    string public constant symbol = "DEMO";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
        emit Transfer(address(0), to, amt);
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        emit Approval(msg.sender, sp, amt);
        return true;
    }
}

/**
 * End-to-end live test on Sepolia.
 *
 * Flow:
 *   1. Deploy our patched SmartAccountFactory (with setExecutor hook).
 *   2. Deploy a fresh user-storage `UserRegistry` proxy (canonical impl on Sepolia
 *      via the canonical VerifiableFactory). This isolates the test from
 *      `looooo.eth`'s production registry.
 *   3. Deploy `ENSignAgentRegistry` pointing at it.
 *   4. Create an EOA-owned smart account "leoTest" (the deployer EOA is the owner).
 *   5. Register "leotest" inside the test storage registry, owned by leoTest.
 *   6. Deploy a DemoToken, mint 1000 to leoTest.
 *   7. Build a Permission: spender = deployer EOA, calls = [DemoToken.transfer],
 *      spends = [100 DEMO / day].
 *   8. As the smart-account owner, call `leoTest.executeBatch` to:
 *        - setExecutor(manager, true)
 *        - manager.approve(permission)        ← deploys agent registry, mints "bot"
 *        - storageRegistry.setSubregistry(leoTokenId, agentRegistry)
 *      All in one batch.
 *   9. Have the spender (deployer EOA) call `manager.executeBatch` with a
 *      DemoToken.transfer of 50 DEMO. Manager validates the call against the
 *      whitelist + spend cap, calls back into leoTest.executeBatch.
 *  10. Verify final balances on-chain.
 */
contract E2EAgentRegistry is Script {
    /// @dev Canonical Sepolia infra (re-used).
    address internal constant CANONICAL_USER_REGISTRY_IMPL =
        0x8CFbF4a6B3F546021b9F8e6099bdA2Cb0297cd25;
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL =
        0x4a333a4f95eB799baC5446CA44301C09cc5AbcDe;
    address internal constant CANONICAL_VERIFIABLE_FACTORY =
        0xb9541BDD86C4D01C726A33694f14e8528AdCb20d;
    address internal constant CANONICAL_ENTRYPOINT =
        0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    /// @dev Test parent label (a fresh stack — not under looooo.eth's production registry).
    string internal constant LEO_LABEL = "leotest";
    string internal constant BOT_LABEL = "bot";

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console2.log("=== ENSignAgentRegistry E2E on Sepolia ===");
        console2.log("deployer", deployer);

        // -------------------------------------------------------------
        // 1. Deploy patched SmartAccountFactory
        // -------------------------------------------------------------
        vm.startBroadcast(deployerKey);
        SmartAccountFactory accountFactory = new SmartAccountFactory(CANONICAL_ENTRYPOINT);
        console2.log("patched smart account factory ", address(accountFactory));

        // -------------------------------------------------------------
        // 2. Deploy fresh user-storage UserRegistry via canonical factory
        // -------------------------------------------------------------
        VerifiableFactory canonicalFactory = VerifiableFactory(CANONICAL_VERIFIABLE_FACTORY);
        bytes memory storageInit = abi.encodeCall(
            UserRegistry.initialize,
            (deployer, EACBaseRolesLib.ALL_ROLES)
        );
        uint256 storageSalt = uint256(keccak256(abi.encode("e2e-storage", deployer, block.timestamp)));
        address testStorageRegistry = canonicalFactory.deployProxy(
            CANONICAL_USER_REGISTRY_IMPL,
            storageSalt,
            storageInit
        );
        console2.log("test storage registry", testStorageRegistry);

        // -------------------------------------------------------------
        // 3. Deploy ENSignAgentRegistry
        // -------------------------------------------------------------
        ENSignAgentRegistry manager = new ENSignAgentRegistry(
            PermissionedRegistry(testStorageRegistry),
            CANONICAL_USER_REGISTRY_IMPL,
            CANONICAL_PERMISSIONED_RESOLVER_IMPL,
            IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY)
        );
        console2.log("agent registry      ", address(manager));

        // -------------------------------------------------------------
        // 4. Create EOA-owned smart account "leoTest"
        // -------------------------------------------------------------
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(deployer);
        uint256 accountNonce = uint256(keccak256(abi.encode("leotest", deployer, block.timestamp)));
        SmartAccount leoTest = accountFactory.createAccount(owners, accountNonce);
        console2.log("leoTest account     ", address(leoTest));

        // -------------------------------------------------------------
        // 5. Register "leotest" name in the test storage registry, owned by leoTest
        // -------------------------------------------------------------
        uint64 expiry = uint64(block.timestamp + 365 days);
        // Grant ALL_ROLES to leoTest on its own token so it can do anything on
        // its name (setSubregistry, setResolver, etc.) without bit-juggling.
        uint256 leoTokenId = PermissionedRegistry(testStorageRegistry).register(
            LEO_LABEL,
            address(leoTest),
            IRegistry(address(0)),
            address(0),
            EACBaseRolesLib.ALL_ROLES,
            expiry
        );
        console2.log("leoTokenId          ", leoTokenId);

        // -------------------------------------------------------------
        // 6. DemoToken + mint to leoTest
        // -------------------------------------------------------------
        DemoToken token = new DemoToken();
        token.mint(address(leoTest), 1000 ether);
        console2.log("DemoToken           ", address(token));

        // -------------------------------------------------------------
        // 7. Build the Permission
        // -------------------------------------------------------------
        ENSignAgentRegistry.CallPermission[] memory calls = new ENSignAgentRegistry.CallPermission[](1);
        calls[0] = ENSignAgentRegistry.CallPermission({
            target: address(token),
            selector: bytes4(keccak256("transfer(address,uint256)")),
            checker: address(0)
        });
        ENSignAgentRegistry.SpendLimit[] memory spends = new ENSignAgentRegistry.SpendLimit[](1);
        spends[0] = ENSignAgentRegistry.SpendLimit({
            token: address(token),
            allowance: 100 ether,
            unit: ENSignAgentRegistry.PeriodUnit.Day,
            multiplier: 1
        });

        // Parent node = namehash("leotest.eth") for our test stack — the actual
        // string isn't load-bearing; it's just used to derive child node hashes
        // for the resolver records.
        bytes32 parentNode = keccak256(
            abi.encodePacked(
                bytes32(0), // no real ENS .eth root in the test stack
                keccak256(bytes(LEO_LABEL))
            )
        );

        ENSignAgentRegistry.Permission memory permission = ENSignAgentRegistry.Permission({
            account: address(leoTest),
            spender: deployer, // deployer plays the agent for this test
            parentNode: parentNode,
            parentTokenId: leoTokenId,
            label: BOT_LABEL,
            start: uint48(block.timestamp),
            end: uint48(block.timestamp + 30 days),
            salt: 1,
            calls: calls,
            spends: spends
        });

        // -------------------------------------------------------------
        // 8. Bootstrap + approve via leoTest.executeBatch (owner-signed)
        // -------------------------------------------------------------
        // We have to send the executeBatch in two stages because the third
        // call needs to read manager.agentRegistryOf(leoTest) which is only
        // populated after approve() runs in the second call.

        IExecutable.Call[] memory batch1 = new IExecutable.Call[](2);
        batch1[0] = IExecutable.Call({
            target: address(leoTest),
            value: 0,
            data: abi.encodeWithSignature("setExecutor(address,bool)", address(manager), true)
        });
        batch1[1] = IExecutable.Call({
            target: address(manager),
            value: 0,
            data: abi.encodeCall(ENSignAgentRegistry.approve, (permission))
        });
        IExecutable(address(leoTest)).executeBatch(batch1);

        address agentRegistry = manager.agentRegistryOf(address(leoTest));
        address resolver = manager.resolverOf(address(leoTest));
        console2.log("agent registry deployed", agentRegistry);
        console2.log("agent resolver         ", resolver);

        IExecutable.Call[] memory batch2 = new IExecutable.Call[](1);
        batch2[0] = IExecutable.Call({
            target: testStorageRegistry,
            value: 0,
            data: abi.encodeCall(
                PermissionedRegistry.setSubregistry,
                (leoTokenId, IRegistry(agentRegistry))
            )
        });
        IExecutable(address(leoTest)).executeBatch(batch2);

        // -------------------------------------------------------------
        // 9. Spender (deployer) executes a transfer through the manager
        // -------------------------------------------------------------
        address recipient = vm.addr(uint256(keccak256("e2e-recipient")));
        IExecutable.Call[] memory agentCalls = new IExecutable.Call[](1);
        agentCalls[0] = IExecutable.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 50 ether)
        });
        manager.executeBatch(permission, agentCalls);

        vm.stopBroadcast();

        // -------------------------------------------------------------
        // 10. Verify
        // -------------------------------------------------------------
        console2.log("=== final state ===");
        console2.log("leoTest balance ", token.balanceOf(address(leoTest)));
        console2.log("recipient balance", token.balanceOf(recipient));
        console2.log("recipient        ", recipient);

        console2.log("isApproved      ", manager.isApproved(permission) ? "true" : "false");
        console2.log("isRevoked       ", manager.isRevoked(permission) ? "true" : "false");
    }
}
