// ENSign demo relay server.
//
// Endpoints:
//   POST /api/register   { label, qx, qy }       → registers a subname under looooo.eth
//                                                   and atomically deploys the smart account.
//   POST /api/predict    { qx, qy }              → returns the deterministic smart account
//                                                   address (canonical factory derivation).
//   POST /api/relay      { userOp }              → submits EntryPoint.handleOps from the
//                                                   relayer EOA (we are also the beneficiary).
//   POST /api/fund       { account, amount }     → tops up an account's EntryPoint deposit so
//                                                   it can pay for its own UserOp gas.
//
// The relayer EOA holds ROLE_REGISTRAR on the registry. Reads come from the same RPC.
//
// Run with: node server.mjs (uses ../.env for PRIVATE_KEY and webauth-demo/.env.local for vars)

import express from "express";
import cors from "cors";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseAbi,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";
import * as fs from "node:fs";
import * as path from "node:path";

// Load env from BOTH the parent .env (PRIVATE_KEY) and webauth-demo/.env.local.
function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnvFile(path.resolve("../.env"));
loadEnvFile(path.resolve(".env.local"));

const PK = process.env.PRIVATE_KEY;
const RPC = process.env.VITE_RPC_URL || process.env.SEPOLIA_RPC_URL;
const REGISTRY = process.env.VITE_REGISTRY;
const ENTRYPOINT = process.env.VITE_ENTRYPOINT;

if (!PK || !RPC || !REGISTRY || !ENTRYPOINT) {
  console.error("Missing env. Need PRIVATE_KEY, VITE_RPC_URL, VITE_REGISTRY, VITE_ENTRYPOINT.");
  process.exit(1);
}

const account = privateKeyToAccount(PK);

const SEPOLIA_RPC = RPC;
const BASE_SEPOLIA_RPC = process.env.VITE_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

const sepoliaPub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const sepoliaWallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
const basePub = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });
const baseWallet = createWalletClient({ account, chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });

function clientsForChain(chainId) {
  if (Number(chainId) === 84532) return { pub: basePub, wallet: baseWallet, chain: "base-sepolia" };
  return { pub: sepoliaPub, wallet: sepoliaWallet, chain: "sepolia" };
}

// Default for legacy code paths that haven't been chain-parameterised yet.
const pub = sepoliaPub;
const wallet = sepoliaWallet;

// Wrapper interface. `predictAccount` is keyed off the passkey coordinates
// (canonical factory derivation), not the label.
const registryAbi = parseAbi([
  "function register(string,bytes32,bytes32,string,uint64) returns (uint256,address)",
  "function predictAccount(bytes32,bytes32) view returns (address)",
  "function getResolver(string) view returns (address)",
]);

// Canonical JustanAccountFactory — same address on every chain.
const JAW_FACTORY = "0x5803c076563C85799989d42Fc00292A8aE52fa9E";
const jawFactoryAbi = parseAbi([
  "function getAddress(bytes[] owners, uint256 nonce) view returns (address)",
]);

function ownersFor(qx, qy) {
  return [encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy])];
}

const epAbi = parseAbi([
  "function depositTo(address) payable",
  "function balanceOf(address) view returns (uint256)",
  "function handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)",
]);

const userOpEventTopic =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", async (_req, res) => {
  const block = await pub.getBlockNumber();
  res.json({ relayer: account.address, block: block.toString(), registry: REGISTRY });
});

// Predict the JAW address from passkey coordinates. The wrapper exposes
// `predictAccount(qx, qy)` which delegates to the canonical factory.
app.post("/api/predict", async (req, res) => {
  try {
    const { qx, qy } = req.body;
    if (!qx || !qy) return res.status(400).json({ error: "qx, qy required" });
    const addr = await pub.readContract({
      address: JAW_FACTORY,
      abi: jawFactoryAbi,
      functionName: "getAddress",
      args: [ownersFor(qx, qy), 0n],
    });
    res.json({ account: addr });
  } catch (e) {
    res.status(400).json({ error: String(e?.shortMessage ?? e) });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { label, qx, qy, credentialId } = req.body;
    if (!label || !qx || !qy) {
      return res.status(400).json({ error: "label, qx, qy required" });
    }
    const credId = typeof credentialId === "string" ? credentialId : "";
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);

    const predicted = await pub.readContract({
      address: JAW_FACTORY,
      abi: jawFactoryAbi,
      functionName: "getAddress",
      args: [ownersFor(qx, qy), 0n],
    });

    // The canonical factory derives the JAW address from the passkey alone, so the same
    // passkey reuses the same account across labels. We can no longer infer "label taken"
    // from JAW bytecode — let the wrapper revert if the label already exists.

    // Pre-fund the EntryPoint deposit so the JAW can pay UserOp gas after register.
    const depositTx = await wallet.writeContract({
      address: ENTRYPOINT,
      abi: epAbi,
      functionName: "depositTo",
      args: [predicted],
      value: parseEther("0.005"),
    });
    await pub.waitForTransactionReceipt({ hash: depositTx });

    // Send a tiny direct balance so JAW can do small `value:` transfers.
    const fundTx = await wallet.sendTransaction({
      to: predicted,
      value: parseEther("0.0001"),
    });
    await pub.waitForTransactionReceipt({ hash: fundTx });

    const registerTx = await wallet.writeContract({
      address: REGISTRY,
      abi: registryAbi,
      functionName: "register",
      args: [label, qx, qy, credId, expiry],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash: registerTx });

    res.json({
      account: predicted,
      registerTx,
      depositTx,
      fundTx,
      blockNumber: receipt.blockNumber.toString(),
    });
  } catch (e) {
    console.error("register failed", e);
    res.status(500).json({ error: String(e?.shortMessage ?? e?.message ?? e) });
  }
});

app.post("/api/relay", async (req, res) => {
  try {
    const { userOp, chainId } = req.body;
    if (!userOp) return res.status(400).json({ error: "userOp required" });

    const { pub: chainPub, wallet: chainWallet, chain } = clientsForChain(chainId || 11155111);
    console.log(`relay → ${chain} (chainId=${chainId})`);

    // Auto-deposit a small amount to EntryPoint on the user's behalf if balance is low,
    // so first UserOp on a new chain succeeds without manual setup.
    const epBal = await chainPub.readContract({
      address: ENTRYPOINT,
      abi: epAbi,
      functionName: "balanceOf",
      args: [userOp.sender],
    });
    if (epBal < parseEther("0.001")) {
      try {
        const depositTx = await chainWallet.writeContract({
          address: ENTRYPOINT,
          abi: epAbi,
          functionName: "depositTo",
          args: [userOp.sender],
          value: parseEther("0.005"),
        });
        await chainPub.waitForTransactionReceipt({ hash: depositTx });
        console.log(`  pre-deposited 0.005 ETH for ${userOp.sender} on ${chain} (tx ${depositTx})`);
      } catch (e) {
        console.warn(`  pre-deposit failed (continuing): ${e?.shortMessage ?? e?.message ?? e}`);
      }
    }

    // Re-cast big-number-ish fields just in case JSON serialised them as strings.
    const op = [
      userOp.sender,
      BigInt(userOp.nonce),
      userOp.initCode,
      userOp.callData,
      userOp.accountGasLimits,
      BigInt(userOp.preVerificationGas),
      userOp.gasFees,
      userOp.paymasterAndData,
      userOp.signature,
    ];

    const tx = await chainWallet.writeContract({
      address: ENTRYPOINT,
      abi: epAbi,
      functionName: "handleOps",
      args: [[op], account.address],
      gas: 2_500_000n,
    });
    const receipt = await chainPub.waitForTransactionReceipt({ hash: tx });

    let success = false;
    let gasUsed = "0";
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === ENTRYPOINT.toLowerCase() && log.topics[0] === userOpEventTopic) {
        const data = log.data.slice(2);
        success = parseInt(data.slice(64, 128), 16) === 1;
        gasUsed = BigInt("0x" + data.slice(192, 256)).toString();
      }
    }

    res.json({
      tx,
      chain,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      success,
      gasUsed,
    });
  } catch (e) {
    console.error("relay failed", e);
    res.status(500).json({ error: String(e?.shortMessage ?? e?.message ?? e) });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`relayer ${account.address} listening on :${port}`);
  console.log(`  registry:   ${REGISTRY}`);
  console.log(`  entrypoint: ${ENTRYPOINT}`);
  console.log(`  rpc:        ${RPC}`);
});
