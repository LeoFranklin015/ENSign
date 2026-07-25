// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";

import { PermissionedRegistry } from "@ensv2/registry/PermissionedRegistry.sol";
import { IRegistry } from "@ensv2/registry/interfaces/IRegistry.sol";
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

/// @notice Toy ERC-20 minted to the test user so the spend-cap path is exercised.
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
 * @title PermissionDemo
 * @notice End-to-end demo of the ENSign agent permission flow against the live
 *         `ensign.eth` Sepolia stack. Useful for judges who want to see the
 *         capability system run on real, verified contracts without going
 *         through the browser UI.
 *
 * Flow:
 *   1. Create a fresh EOA-owned smart account for the test user.
 *   2. Register `<userLabel>.ensign.eth` against the live storage proxy,
 *      owned by the smart account.
 *   3. Mint a DemoToken balance to the user account.
 *   4. Build a `Permission` granting the deployer EOA agent rights to call
 *      `transfer` on the DemoToken, capped at 100/day, valid for 30 days.
 *   5. Through the user account: enable the manager as an executor and
 *      approve the permission, which lazy-deploys the user's per-account
 *      `ENSignAgentRegistry` clone and mints `bot.<userLabel>.ensign.eth`.
 *   6. Wire the user's subregistry pointer at the new agent registry so the
 *      agent subname resolves through the canonical resolution path.
 *   7. Agent (deployer) submits a token transfer through `manager.executeBatch`
 *      and the on-chain validator checks target / selector / spend cap /
 *      expiry / parent ownership before forwarding.
 *
 * Pre-requisites:
 *   - `PRIVATE_KEY` env var must hold an EOA with `ROLE_REGISTRAR` on the
 *     `ensign.eth` user-storage proxy (the deployer EOA from `DeployENSign`
 *     gets it automatically).
 *   - `SEPOLIA_RPC_URL` env var.
 */
contract PermissionDemo is Script {
    /// @dev Live `ensign.eth` user-storage proxy (canonical UserRegistry impl,
    ///      sepolia-official-v1-20260525-r2 stack).
    address internal constant USER_STORAGE_REGISTRY =
        0x674cBe3246596871f18B2fe3489E09D77734fE06;

    /// @dev Already-deployed `ENSignAgentRegistry` (the manager).
    address internal constant AGENT_MANAGER =
        0x4303e050dc19F8428F146b8E941C75dF9cDd00f2;

    /// @dev Smart-account factory used by ENSign.
    address internal constant SMART_ACCOUNT_FACTORY =
        0x5803c076563C85799989d42Fc00292A8aE52fa9E;

    /// @dev Canonical infra (sepolia-official-v1-20260525-r2).
    address internal constant CANONICAL_PERMISSIONED_RESOLVER_IMPL =
        0xdcE5205A553573FFd47629327DDdf36186022FfA;
    address internal constant CANONICAL_VERIFIABLE_FACTORY =
        0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198;

    string internal constant BOT_LABEL = "bot";

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // Make the user label unique per run so reruns don't clash.
        string memory userLabel = string.concat("perm", vm.toString(block.timestamp));

        bytes32 ensignNode = Addresses.parentNode();
        bytes32 userParentNode =
            keccak256(abi.encodePacked(ensignNode, keccak256(bytes(userLabel))));

        console2.log("=== ENSign Permission Demo ===");
        console2.log("deployer (registrar/spender)", deployer);
        console2.log("user label                  ", userLabel);

        vm.startBroadcast(deployerKey);

        // ─── 1. Create a fresh smart account for the test user ───
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(deployer);
        uint256 accNonce = uint256(keccak256(abi.encode(userLabel, deployer, block.timestamp)));
        SmartAccount userAcc = SmartAccountFactory(SMART_ACCOUNT_FACTORY).createAccount(owners, accNonce);
        console2.log("user smart account          ", address(userAcc));

        // ─── 2. Deploy a writable resolver and point addr(node, 60) at the smart account ───
        bytes memory resInit = abi.encodeCall(
            IPermissionedResolver.initialize,
            (deployer, EACBaseRolesLib.ALL_ROLES)
        );
        uint256 resSalt = uint256(keccak256(abi.encode("perm-demo-res", deployer, block.timestamp)));
        address userResolver = IVerifiableFactoryLite(CANONICAL_VERIFIABLE_FACTORY).deployProxy(
            CANONICAL_PERMISSIONED_RESOLVER_IMPL, resSalt, resInit
        );
        IPermissionedResolver(userResolver).setAddr(
            userParentNode, 60, abi.encodePacked(address(userAcc))
        );

        // ─── 3. Mint <userLabel>.ensign.eth into the storage proxy, owned by the smart account ───
        uint64 expiry = uint64(block.timestamp + 365 days);
        uint256 userTokenId = PermissionedRegistry(USER_STORAGE_REGISTRY).register(
            userLabel,
            address(userAcc),
            IRegistry(address(0)),
            userResolver,
            EACBaseRolesLib.ALL_ROLES,
            expiry
        );
        console2.log("user.ensign.eth tokenId     ", userTokenId);

        // ─── 4. DemoToken + mint 1000 to the user account ───
        DemoToken token = new DemoToken();
        token.mint(address(userAcc), 1000 ether);
        console2.log("DemoToken                   ", address(token));

        // ─── 5. Build the Permission ───
        ENSignAgentRegistry manager = ENSignAgentRegistry(AGENT_MANAGER);
        ENSignAgentRegistry.CallPermission[] memory calls =
            new ENSignAgentRegistry.CallPermission[](1);
        calls[0] = ENSignAgentRegistry.CallPermission({
            target: address(token),
            selector: bytes4(keccak256("transfer(address,uint256)")),
            checker: address(0)
        });
        ENSignAgentRegistry.SpendLimit[] memory spends =
            new ENSignAgentRegistry.SpendLimit[](1);
        spends[0] = ENSignAgentRegistry.SpendLimit({
            token: address(token),
            allowance: 100 ether,
            unit: ENSignAgentRegistry.PeriodUnit.Day,
            multiplier: 1
        });
        ENSignAgentRegistry.Permission memory permission = ENSignAgentRegistry.Permission({
            account: address(userAcc),
            spender: deployer,
            parentNode: userParentNode,
            parentTokenId: userTokenId,
            label: BOT_LABEL,
            start: uint48(block.timestamp),
            end: uint48(block.timestamp + 30 days),
            salt: 1,
            calls: calls,
            spends: spends
        });

        // ─── 6. Bootstrap + approve via userAcc.executeBatch ───
        IExecutable.Call[] memory batch1 = new IExecutable.Call[](2);
        batch1[0] = IExecutable.Call({
            target: address(userAcc),
            value: 0,
            data: abi.encodeWithSignature("setExecutor(address,bool)", address(manager), true)
        });
        batch1[1] = IExecutable.Call({
            target: address(manager),
            value: 0,
            data: abi.encodeCall(ENSignAgentRegistry.approve, (permission))
        });
        IExecutable(address(userAcc)).executeBatch(batch1);

        address agentRegistry = manager.agentRegistryOf(address(userAcc));
        console2.log("agent registry deployed     ", agentRegistry);

        // ─── 7. Wire the user's subregistry pointer at the agent registry ───
        IExecutable.Call[] memory batch2 = new IExecutable.Call[](1);
        batch2[0] = IExecutable.Call({
            target: USER_STORAGE_REGISTRY,
            value: 0,
            data: abi.encodeCall(
                PermissionedRegistry.setSubregistry,
                (userTokenId, IRegistry(agentRegistry))
            )
        });
        IExecutable(address(userAcc)).executeBatch(batch2);

        // ─── 8. Agent (deployer) executes a token transfer through the manager ───
        address recipient = vm.addr(uint256(keccak256("perm-demo-recipient")));
        IExecutable.Call[] memory agentCalls = new IExecutable.Call[](1);
        agentCalls[0] = IExecutable.Call({
            target: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 50 ether)
        });
        manager.executeBatch(permission, agentCalls);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Result ===");
        console2.log("user balance after          ", token.balanceOf(address(userAcc)));
        console2.log("recipient balance after     ", token.balanceOf(recipient));
        console2.log("recipient                   ", recipient);
        console2.log("permission approved         ", manager.isApproved(permission) ? "true" : "false");
        console2.log("");
        console2.log("Look up on https://explorer.ens.dev/ensign.eth/subnames :");
        console2.log("  user name : ", string.concat(userLabel, ".ensign.eth"));
        console2.log("  agent name: ", string.concat(BOT_LABEL, ".", userLabel, ".ensign.eth"));
    }
}
