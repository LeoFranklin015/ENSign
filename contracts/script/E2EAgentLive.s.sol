// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";

import { UserRegistry } from "@ensv2/registry/UserRegistry.sol";
import { PermissionedRegistry } from "@ensv2/registry/PermissionedRegistry.sol";
import { IRegistry } from "@ensv2/registry/interfaces/IRegistry.sol";
import { RegistryRolesLib } from "@ensv2/registry/libraries/RegistryRolesLib.sol";
import { EACBaseRolesLib } from "@ensv2/access-control/libraries/EACBaseRolesLib.sol";

import { SmartAccount } from "@account/SmartAccount.sol";
import { SmartAccountFactory } from "@account/SmartAccountFactory.sol";

import {
    ENSignAgentRegistry,
    IExecutable,
    IPermissionedResolver,
    IVerifiableFactoryLite
} from "../src/ENSignAgentRegistry.sol";

import { Addresses } from "./Addresses.sol";

/// @notice Toy ERC-20 minted to the test user so we can exercise the spend-cap path.
contract DemoToken {
    string public constant name = "DemoToken";
    string public constant symbol = "DEMO";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
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
}

/**
 * Live e2e under PRODUCTION `looooo.eth`. Unlike `E2EAgentRegistry`, this script
 * registers the test user inside the *existing* canonical user-storage proxy
 * that `looooo.eth` already points at — so the resulting `<label>.looooo.eth`
 * and `bot.<label>.looooo.eth` names actually appear in the ENS explorer.
 *
 * Pre-requisites the deployer EOA must have:
 *   - `ROLE_REGISTRAR` on user-storage proxy `0x7caf267cf8df169a583ddd22dbd95a58501c6d90`
 *     (granted at deploy time when initialized with `(deployer, ALL_ROLES)`).
 *   - Looooo.eth's subregistry pointer on `ETH_REGISTRY` must already point at
 *     that storage proxy (set by `DeployENSign.s.sol` step 4 — already done).
 *
 * Flow:
 *   1. Deploy fresh `ENSignAgentRegistry` pointing at the production storage proxy.
 *   2. Re-use the previously-deployed patched `SmartAccountFactory` (or deploy fresh).
 *   3. Create EOA-owned smart account "leotestAcc" via the patched factory.
 *   4. Register a fresh subname `leotest<timestamp>.looooo.eth` directly into the
 *      production storage proxy, owned by leotestAcc, with ALL_ROLES on its token.
 *      Bypasses the wrapper because the wrapper only mints passkey-derived smart accounts.
 *   5. Deploy DemoToken, mint to leotestAcc.
 *   6. Build a Permission for agent `bot` controlled by deployer EOA.
 *   7. Through `leotestAcc.executeBatch`: setExecutor(manager, true) + manager.approve(p).
 *   8. Through `leotestAcc.executeBatch`: setSubregistry(leotestTokenId, agentRegistry)
 *      so `bot.leotest...looooo.eth` resolves through the canonical UR.
 *   9. Spender (deployer) executes a transfer through manager.executeBatch.
 *  10. Print final addresses and the actual ENS names so they can be checked at
 *      explorer.ens.dev.
 */
contract E2EAgentLive is Script {
    /// @dev Storage proxy under looooo.eth — still on the OLD (pre-20260525) staging
    ///      deployment; redeploy under the new stack before reusing this script.
    address internal constant USER_STORAGE_REGISTRY =
        0x7caf267cF8DF169a583DDd22DbD95a58501C6d90;

    /// @dev Canonical infra (sepolia-official-v1-20260525-r2).
    address internal constant CANONICAL_USER_REGISTRY_IMPL =
        0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917;
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL =
        0xdcE5205A553573FFd47629327DDdf36186022FfA;
    address internal constant CANONICAL_VERIFIABLE_FACTORY =
        0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198;
    address internal constant CANONICAL_ENTRYPOINT =
        0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

    /// @dev Agent label minted under leotest in this run.
    string internal constant BOT_LABEL = "bot";

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Make the user label unique per run so reruns don't clash.
        string memory leoLabel = string.concat("leotest", vm.toString(block.timestamp));
        bytes32 looooNode = Addresses.parentNode();
        bytes32 leoParentNode = keccak256(abi.encodePacked(looooNode, keccak256(bytes(leoLabel))));

        console2.log("=== ENSignAgentRegistry LIVE e2e under looooo.eth ===");
        console2.log("deployer            ", deployer);
        console2.log("leoLabel            ", leoLabel);

        vm.startBroadcast(deployerKey);

        // 1. Deploy patched SmartAccountFactory + ENSignAgentRegistry pointing at production storage.
        SmartAccountFactory accountFactory = new SmartAccountFactory(CANONICAL_ENTRYPOINT);
        ENSignAgentRegistry manager = new ENSignAgentRegistry(
            PermissionedRegistry(USER_STORAGE_REGISTRY),
            CANONICAL_USER_REGISTRY_IMPL,
            CANONICAL_PERMISSIONED_RESOLVER_IMPL,
            IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY)
        );
        console2.log("patched smart account factory ", address(accountFactory));
        console2.log("agent registry      ", address(manager));

        // 2. Create EOA-owned smart account.
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(deployer);
        uint256 accountNonce = uint256(keccak256(abi.encode("leotestAcc", deployer, block.timestamp)));
        SmartAccount leotestAcc = accountFactory.createAccount(owners, accountNonce);
        console2.log("leotestAcc          ", address(leotestAcc));

        // 3. Deploy a per-subname resolver for leotest (so the indexer picks it up).
        //    Mirrors what ENSignRegistry does for its subnames — a fresh
        //    PermissionedResolver proxy via the canonical VerifiableFactory, with
        //    addr(node, 60) = leotestAcc.
        bytes memory resInit = abi.encodeCall(
            IPermissionedResolver.initialize,
            (deployer, EACBaseRolesLib.ALL_ROLES)
        );
        uint256 resSalt = uint256(keccak256(abi.encode("leo-resolver", deployer, block.timestamp)));
        address userResolver = IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY).deployProxy(
            CANONICAL_PERMISSIONED_RESOLVER_IMPL, resSalt, resInit
        );
        IPermissionedResolver(userResolver).setAddr(leoParentNode, 60, abi.encodePacked(address(leotestAcc)));
        console2.log("user resolver        ", userResolver);

        // 4. Mint <leoLabel> directly into the production storage proxy, owned by leotestAcc.
        //    Deployer holds ROLE_REGISTRAR there from the original deployment.
        uint64 expiry = uint64(block.timestamp + 365 days);
        uint256 leoTokenId = PermissionedRegistry(USER_STORAGE_REGISTRY).register(
            leoLabel,
            address(leotestAcc),
            IRegistry(address(0)),
            userResolver,
            EACBaseRolesLib.ALL_ROLES,
            expiry
        );
        console2.log("leoTokenId          ", leoTokenId);

        // 4. DemoToken + mint to leotestAcc.
        DemoToken token = new DemoToken();
        token.mint(address(leotestAcc), 1000 ether);
        console2.log("DemoToken           ", address(token));

        // 5. Build the Permission.
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
        ENSignAgentRegistry.Permission memory permission = ENSignAgentRegistry.Permission({
            account: address(leotestAcc),
            spender: deployer,
            parentNode: leoParentNode,
            parentTokenId: leoTokenId,
            label: BOT_LABEL,
            start: uint48(block.timestamp),
            end: uint48(block.timestamp + 30 days),
            salt: 1,
            calls: calls,
            spends: spends
        });

        // 6. Bootstrap + approve via leotestAcc.executeBatch (owner-signed, msg.sender = deployer).
        IExecutable.Call[] memory batch1 = new IExecutable.Call[](2);
        batch1[0] = IExecutable.Call({
            target: address(leotestAcc),
            value: 0,
            data: abi.encodeWithSignature("setExecutor(address,bool)", address(manager), true)
        });
        batch1[1] = IExecutable.Call({
            target: address(manager),
            value: 0,
            data: abi.encodeCall(ENSignAgentRegistry.approve, (permission))
        });
        IExecutable(address(leotestAcc)).executeBatch(batch1);

        address agentRegistry = manager.agentRegistryOf(address(leotestAcc));
        address resolver = manager.resolverOf(address(leotestAcc));
        console2.log("agent registry deployed", agentRegistry);
        console2.log("agent resolver         ", resolver);

        // 7. Wire <leoLabel>.looooo.eth's subregistry pointer at the agent registry so
        //    bot.<leoLabel>.looooo.eth resolves through the canonical UR.
        IExecutable.Call[] memory batch2 = new IExecutable.Call[](1);
        batch2[0] = IExecutable.Call({
            target: USER_STORAGE_REGISTRY,
            value: 0,
            data: abi.encodeCall(
                PermissionedRegistry.setSubregistry,
                (leoTokenId, IRegistry(agentRegistry))
            )
        });
        IExecutable(address(leotestAcc)).executeBatch(batch2);

        // 8. Agent run — spender (deployer) calls manager.executeBatch with a DemoToken transfer.
        address recipient = vm.addr(uint256(keccak256("e2e-live-recipient")));
        IExecutable.Call[] memory agentCalls = new IExecutable.Call[](1);
        agentCalls[0] = IExecutable.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 50 ether)
        });
        manager.executeBatch(permission, agentCalls);

        vm.stopBroadcast();

        console2.log("=== final state ===");
        console2.log("leotestAcc balance ", token.balanceOf(address(leotestAcc)));
        console2.log("recipient balance  ", token.balanceOf(recipient));
        console2.log("recipient          ", recipient);
        console2.log("isApproved         ", manager.isApproved(permission) ? "true" : "false");

        console2.log("");
        console2.log("Look these up in https://explorer.ens.dev/looooo.eth/subnames :");
        console2.log("  user name : ", string.concat(leoLabel, ".looooo.eth"));
        console2.log("  agent name: ", string.concat("bot.", leoLabel, ".looooo.eth"));
    }
}
