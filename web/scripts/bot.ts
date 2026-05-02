/**
 * Standalone ENSign agent runner.
 *
 *   1. Resolves the agent registry + per-user resolver from the ENSignAgentRegistry
 *      contract on Sepolia.
 *   2. Reads `addr(node, 60)` and `text(node, "permission")` straight off the
 *      ENS resolver — same data the indexer would expose. The agent uses ENS
 *      as the source of truth for "what permission do I have?".
 *   3. Reconstructs the Permission struct locally (in production this would be
 *      handed over by the SDK / webpage at approval time), hashes it on-chain
 *      via `manager.getHash(p)`, asserts it equals the `text("permission")` value.
 *   4. Builds an arbitrary call (here: ERC-20 `transfer`) and submits it via
 *      `manager.executeBatch(p, calls)`.
 *
 * The whole point of step 2-3 is that the bot is identified to itself by its
 * ENS subname — flip the keypair, the resolver lookup mismatches, the script
 * refuses to run. No off-chain shared secret.
 *
 * Run:
 *   cd webauth-demo
 *   tsx scripts/bot.ts
 *
 * Required env (typically loaded from .env):
 *   BOT_PRIVATE_KEY      — the agent EOA's key (its addr must match `addr(60)` on the resolver)
 *   SEPOLIA_RPC_URL      — RPC endpoint
 *   MANAGER              — ENSignAgentRegistry address
 *   USER_ACCOUNT         — user's smart account address
 *   PARENT_NODE          — namehash of <userLabel>.<parentName>
 *   PARENT_TOKEN_ID      — user's tokenId (uint256, decimal string ok)
 *   BOT_LABEL            — agent label (e.g., "bot")
 *   PERMISSION_START / PERMISSION_END / PERMISSION_SALT
 *   TOKEN                — ERC-20 the agent has permission to transfer
 *   TOKEN_ALLOWANCE      — daily cap from the original Permission
 *   RECIPIENT            — where to send tokens
 *   AMOUNT               — how many wei to send
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  keccak256,
  toBytes,
  toHex,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as fs from "node:fs";
import * as path from "node:path";

// ───────────────────────── env loading ─────────────────────────

function loadEnv(p: string) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv(path.resolve("../.env"));
loadEnv(path.resolve(".env.local"));
loadEnv(path.resolve(".env"));

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

const BOT_PK = req("BOT_PRIVATE_KEY") as Hex;
const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const MANAGER = req("MANAGER") as Address;
const USER_ACCOUNT = req("USER_ACCOUNT") as Address;
const PARENT_NODE = req("PARENT_NODE") as Hex;
const PARENT_TOKEN_ID = BigInt(req("PARENT_TOKEN_ID"));
const BOT_LABEL = req("BOT_LABEL");
const PERMISSION_START = BigInt(req("PERMISSION_START"));
const PERMISSION_END = BigInt(req("PERMISSION_END"));
const PERMISSION_SALT = BigInt(req("PERMISSION_SALT"));
const TOKEN = req("TOKEN") as Address;
const TOKEN_ALLOWANCE = BigInt(req("TOKEN_ALLOWANCE"));
const RECIPIENT = req("RECIPIENT") as Address;
const AMOUNT = BigInt(req("AMOUNT"));

if (!isAddress(MANAGER) || !isAddress(USER_ACCOUNT) || !isAddress(TOKEN) || !isAddress(RECIPIENT)) {
  console.error("one of MANAGER / USER_ACCOUNT / TOKEN / RECIPIENT is not a valid address");
  process.exit(1);
}

// ───────────────────────── ABIs ─────────────────────────

// Named-tuple form so viem maps JS object fields by name (anonymous tuples
// crash viem's encoder when passed JS objects).
const PERMISSION_TUPLE =
  "(address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends)";
const CALL_TUPLE = "(address target,uint256 value,bytes data)";

const managerAbi = parseAbi([
  "function agentRegistryOf(address account) view returns (address)",
  "function resolverOf(address account) view returns (address)",
  `function isApproved(${PERMISSION_TUPLE} permission) view returns (bool)`,
  `function isRevoked(${PERMISSION_TUPLE} permission) view returns (bool)`,
  `function getHash(${PERMISSION_TUPLE} permission) view returns (bytes32)`,
  `function executeBatch(${PERMISSION_TUPLE} permission, ${CALL_TUPLE}[] calls)`,
]);

const registryAbi = parseAbi([
  "function getResolver(string label) view returns (address)",
]);

const resolverAbi = parseAbi([
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
]);

// PeriodUnit enum mirrors the contract's:
// 0=Minute 1=Hour 2=Day 3=Week 4=Month 5=Forever
const DAY_UNIT = 2;
const TRANSFER_SELECTOR = "0xa9059cbb" as Hex; // keccak("transfer(address,uint256)")[:4]

// ───────────────────────── helpers ─────────────────────────

/// childNode = keccak256(parentNode ‖ keccak256(label))
function childNode(parent: Hex, label: string): Hex {
  const labelHash = keccak256(toBytes(label));
  const buf = new Uint8Array(64);
  buf.set(toBytes(parent), 0);
  buf.set(toBytes(labelHash), 32);
  return keccak256(buf);
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const botAccount = privateKeyToAccount(BOT_PK);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account: botAccount, chain: sepolia, transport: http(RPC) });

  console.log("=== ENSign Bot ===");
  console.log("bot       ", botAccount.address);
  console.log("manager   ", MANAGER);
  console.log("user acc  ", USER_ACCOUNT);
  console.log("botLabel  ", BOT_LABEL);

  // 1. resolve agent registry + shared resolver
  const [agentRegistry, resolver] = await Promise.all([
    publicClient.readContract({
      address: MANAGER, abi: managerAbi, functionName: "agentRegistryOf", args: [USER_ACCOUNT],
    }),
    publicClient.readContract({
      address: MANAGER, abi: managerAbi, functionName: "resolverOf", args: [USER_ACCOUNT],
    }),
  ]);
  if (agentRegistry === "0x0000000000000000000000000000000000000000") throw new Error("no agent registry for this user");
  if (resolver === "0x0000000000000000000000000000000000000000") throw new Error("no resolver for this user");
  console.log("agent reg ", agentRegistry);
  console.log("resolver  ", resolver);

  // sanity: same resolver via the registry's getResolver()
  const resolverFromReg = await publicClient.readContract({
    address: agentRegistry as Address, abi: registryAbi, functionName: "getResolver", args: [BOT_LABEL],
  });
  if (resolverFromReg.toLowerCase() !== (resolver as string).toLowerCase()) {
    throw new Error(`resolver mismatch: registry says ${resolverFromReg}, manager says ${resolver}`);
  }

  // 2. read agent's records from ENS
  const botNode = childNode(PARENT_NODE, BOT_LABEL);
  console.log("botNode   ", botNode);

  const [addrBytes, ensPermissionHexStr] = await Promise.all([
    publicClient.readContract({
      address: resolver as Address, abi: resolverAbi, functionName: "addr", args: [botNode, 60n],
    }) as Promise<Hex>,
    publicClient.readContract({
      address: resolver as Address, abi: resolverAbi, functionName: "text", args: [botNode, "permission"],
    }) as Promise<string>,
  ]);
  const addrFromEns = ("0x" + addrBytes.slice(2).slice(-40)) as Address;
  if (addrFromEns.toLowerCase() !== botAccount.address.toLowerCase()) {
    throw new Error(`ENS addr ${addrFromEns} does not match bot signer ${botAccount.address}`);
  }
  const ensPermissionHash = ensPermissionHexStr as Hex;
  console.log("ens hash  ", ensPermissionHash);

  // 3. reconstruct Permission, verify hash via the contract
  const permission = {
    account: USER_ACCOUNT,
    spender: botAccount.address,
    parentNode: PARENT_NODE,
    parentTokenId: PARENT_TOKEN_ID,
    label: BOT_LABEL,
    start: PERMISSION_START,
    end: PERMISSION_END,
    salt: PERMISSION_SALT,
    calls: [{ target: TOKEN, selector: TRANSFER_SELECTOR, checker: "0x0000000000000000000000000000000000000000" as Address }],
    spends: [{ token: TOKEN, allowance: TOKEN_ALLOWANCE, unit: DAY_UNIT, multiplier: 1 }],
  } as const;

  const localHash = await publicClient.readContract({
    address: MANAGER, abi: managerAbi, functionName: "getHash", args: [permission],
  });
  if ((localHash as Hex).toLowerCase() !== ensPermissionHash.toLowerCase()) {
    throw new Error(
      `Permission hash mismatch:\n  local: ${localHash}\n  ENS:   ${ensPermissionHash}\n` +
      `Check that PARENT_NODE / PARENT_TOKEN_ID / PERMISSION_START / END / SALT / TOKEN / TOKEN_ALLOWANCE all match what was approved.`,
    );
  }

  const [approved, revoked] = await Promise.all([
    publicClient.readContract({ address: MANAGER, abi: managerAbi, functionName: "isApproved", args: [permission] }),
    publicClient.readContract({ address: MANAGER, abi: managerAbi, functionName: "isRevoked", args: [permission] }),
  ]);
  if (!approved) throw new Error("permission not approved on-chain");
  if (revoked) throw new Error("permission revoked");

  console.log("permission verified, executing transfer...");

  // 4. agent action: transfer(recipient, amount)
  const calls = [
    {
      target: TOKEN,
      value: 0n,
      data: encodeFunctionData({
        abi: parseAbi(["function transfer(address,uint256)"]),
        functionName: "transfer",
        args: [RECIPIENT, AMOUNT],
      }),
    },
  ];

  const hash = await walletClient.writeContract({
    address: MANAGER,
    abi: managerAbi,
    functionName: "executeBatch",
    args: [permission, calls],
  });

  console.log("submitted ", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status    ", receipt.status);
  console.log("block     ", receipt.blockNumber);

  console.log("=== done ===");
  console.log("transferred", AMOUNT.toString(), "to", RECIPIENT);
  console.log("etherscan ", `https://sepolia.etherscan.io/tx/${hash}`);

  // unused but kept for ref
  void toHex;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
