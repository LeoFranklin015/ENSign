// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";

import { PermissionedRegistry } from "@ensv2/registry/PermissionedRegistry.sol";

import {
    ENSignAgentRegistry,
    IExecutable,
    IPermissionedResolver
} from "../src/ENSignAgentRegistry.sol";

/**
 * @title BotAgentRun
 *
 * @notice The "bot" side of the agent flow. The user has already granted a
 *         permission via the webpage (or `E2EAgentLive`); the agent now picks
 *         up its capability *from ENS* — no off-chain handshake needed for the
 *         identity check — and runs whatever calls it has authority for.
 *
 * Flow inside `run()`:
 *
 *   1. Resolve the agent registry for the user's account:
 *           manager.agentRegistryOf(account) → agentRegistry
 *
 *   2. Resolve the per-user shared resolver:
 *           agentRegistry.getResolver(BOT_LABEL) → resolver
 *
 *   3. Compute the agent's namehash and read its records from the resolver:
 *           addr(node, 60)        → spender (sanity-checked against msg.sender)
 *           text(node, "permission") → permission hash baked at approve time
 *
 *   4. Local cross-check: hash the locally-known Permission struct via
 *      `manager.getHash(p)` and confirm it equals the on-chain text record.
 *      This is what proves "I'm the agent for this exact policy" without
 *      needing the SDK to ship the hash separately — ENS is the source of truth.
 *
 *   5. Build a `transfer(recipient, amount)` call on the demo token and submit
 *      it through `manager.executeBatch(p, calls)`. Manager validates the call
 *      against the whitelist + spend cap, then calls back into the user's
 *      account.executeBatch.
 *
 * Env inputs (filled in from the most recent `E2EAgentLive` broadcast — in a
 * real deploy these would be configured per-agent, e.g. via SDK):
 *
 *   PRIVATE_KEY      — the bot EOA's key (must equal the resolver's `addr`)
 *   MANAGER          — ENSignAgentRegistry deployed on Sepolia
 *   USER_ACCOUNT     — the user's smart account
 *   PARENT_NODE      — namehash of <userLabel>.looooo.eth
 *   PARENT_TOKEN_ID  — user's tokenId in the user-storage registry
 *   BOT_LABEL        — agent label (e.g., "bot")
 *   PERMISSION_START / PERMISSION_END / PERMISSION_SALT
 *   TOKEN            — ERC-20 the bot has permission to transfer
 *   TOKEN_ALLOWANCE  — daily cap from the original Permission
 *   RECIPIENT        — where to send tokens
 *   AMOUNT           — how many tokens (in wei)
 */
contract BotAgentRun is Script {
    function run() external {
        uint256 botKey = vm.envUint("PRIVATE_KEY");
        address botSpender = vm.addr(botKey);

        ENSignAgentRegistry manager = ENSignAgentRegistry(vm.envAddress("MANAGER"));
        address account = vm.envAddress("USER_ACCOUNT");
        bytes32 parentNode = vm.envBytes32("PARENT_NODE");
        uint256 parentTokenId = vm.envUint("PARENT_TOKEN_ID");
        string memory botLabel = vm.envString("BOT_LABEL");

        uint48 start = uint48(vm.envUint("PERMISSION_START"));
        uint48 end = uint48(vm.envUint("PERMISSION_END"));
        uint256 salt = vm.envUint("PERMISSION_SALT");

        address token = vm.envAddress("TOKEN");
        uint160 allowance = uint160(vm.envUint("TOKEN_ALLOWANCE"));
        address recipient = vm.envAddress("RECIPIENT");
        uint256 amount = vm.envUint("AMOUNT");

        console2.log("=== BotAgentRun ===");
        console2.log("bot       ", botSpender);
        console2.log("manager   ", address(manager));
        console2.log("account   ", account);
        console2.log("botLabel  ", botLabel);

        // ─── 1. Find the agent registry + shared resolver from the manager. ───
        address agentRegistry = manager.agentRegistryOf(account);
        require(agentRegistry != address(0), "user has no agent registry yet");
        address resolver = manager.resolverOf(account);
        require(resolver != address(0), "user has no agent resolver yet");

        console2.log("agent reg ", agentRegistry);
        console2.log("resolver  ", resolver);

        // Sanity: the agent registry should also expose this resolver via getResolver(label).
        address resolverFromRegistry =
            PermissionedRegistry(agentRegistry).getResolver(botLabel);
        require(resolverFromRegistry == resolver, "resolver mismatch");

        // ─── 2. Read the bot's records straight from ENS state. ───
        bytes32 botNode = _childNode(parentNode, keccak256(bytes(botLabel)));
        bytes memory addrBytes = _getAddr(resolver, botNode);
        require(addrBytes.length == 20, "unexpected addr length");
        address addrFromEns = address(uint160(bytes20(addrBytes)));
        require(addrFromEns == botSpender, "ENS addr does not match this signer");

        string memory permHashHex = _getText(resolver, botNode, "permission");
        bytes32 ensPermissionHash = _parseHexBytes32(permHashHex);
        console2.log("ens hash  ", permHashHex);

        // ─── 3. Reconstruct the Permission locally from env, verify hash matches. ───
        ENSignAgentRegistry.CallPermission[] memory calls = new ENSignAgentRegistry.CallPermission[](1);
        calls[0] = ENSignAgentRegistry.CallPermission({
            target: token,
            selector: bytes4(keccak256("transfer(address,uint256)")),
            checker: address(0)
        });
        ENSignAgentRegistry.SpendLimit[] memory spends = new ENSignAgentRegistry.SpendLimit[](1);
        spends[0] = ENSignAgentRegistry.SpendLimit({
            token: token,
            allowance: allowance,
            unit: ENSignAgentRegistry.PeriodUnit.Day,
            multiplier: 1
        });

        ENSignAgentRegistry.Permission memory permission = ENSignAgentRegistry.Permission({
            account: account,
            spender: botSpender,
            parentNode: parentNode,
            parentTokenId: parentTokenId,
            label: botLabel,
            start: start,
            end: end,
            salt: salt,
            calls: calls,
            spends: spends
        });

        bytes32 localHash = manager.getHash(permission);
        require(localHash == ensPermissionHash, "local Permission hash does not match ENS record");

        require(manager.isApproved(permission), "permission not approved");
        require(!manager.isRevoked(permission), "permission revoked");

        console2.log("permission verified, executing transfer...");

        // ─── 4. Run the agent action. ───
        IExecutable.Call[] memory agentCalls = new IExecutable.Call[](1);
        agentCalls[0] = IExecutable.Call({
            target: token,
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", recipient, amount)
        });

        vm.startBroadcast(botKey);
        manager.executeBatch(permission, agentCalls);
        vm.stopBroadcast();

        console2.log("=== done ===");
        console2.log("transferred", amount);
        console2.log("to         ", recipient);
    }

    // ───────────────────────────────── ENS helpers ─────────────────────────────────

    function _childNode(bytes32 parent, bytes32 labelHash) internal pure returns (bytes32 node) {
        assembly {
            mstore(0, parent)
            mstore(32, labelHash)
            node := keccak256(0, 64)
        }
    }

    function _getAddr(address resolver, bytes32 node) internal view returns (bytes memory) {
        // canonical PermissionedResolver multi-coin addr
        (bool ok, bytes memory ret) = resolver.staticcall(
            abi.encodeWithSignature("addr(bytes32,uint256)", node, uint256(60))
        );
        require(ok, "resolver.addr reverted");
        return abi.decode(ret, (bytes));
    }

    function _getText(address resolver, bytes32 node, string memory key)
        internal
        view
        returns (string memory)
    {
        (bool ok, bytes memory ret) = resolver.staticcall(
            abi.encodeWithSignature("text(bytes32,string)", node, key)
        );
        require(ok, "resolver.text reverted");
        return abi.decode(ret, (string));
    }

    /// @dev Parses a "0x"-prefixed 64-char hex string into bytes32.
    function _parseHexBytes32(string memory s) internal pure returns (bytes32 result) {
        bytes memory b = bytes(s);
        require(b.length == 66 && b[0] == "0" && b[1] == "x", "bad hex string");
        for (uint256 i = 0; i < 32; ++i) {
            uint8 hi = _hexNibble(b[2 + i * 2]);
            uint8 lo = _hexNibble(b[3 + i * 2]);
            result |= bytes32(uint256(hi * 16 + lo) << ((31 - i) * 8));
        }
    }

    function _hexNibble(bytes1 c) internal pure returns (uint8) {
        uint8 b = uint8(c);
        if (b >= 48 && b <= 57) return b - 48;        // 0-9
        if (b >= 97 && b <= 102) return b - 97 + 10;  // a-f
        if (b >= 65 && b <= 70) return b - 65 + 10;   // A-F
        revert("bad hex char");
    }
}
