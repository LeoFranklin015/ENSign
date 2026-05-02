import { NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, baseSepolia } from "viem/chains";

/// Reconstruction of the Permission struct passed to ENSignAgentRegistry.
/// Field order MUST match the on-chain tuple (named ABI components).
type Permission = {
  account: Address;
  spender: Address;
  parentNode: Hex;
  parentTokenId: bigint;
  label: string;
  start: number;
  end: number;
  salt: bigint;
  calls: Array<{ target: Address; selector: Hex; checker: Address }>;
  spends: Array<{
    token: Address;
    allowance: bigint;
    unit: number;
    multiplier: number;
  }>;
};

type Call = { target: Address; value: bigint; data: Hex };

// Signatures too long for parseAbi's type-level parser — cast to Abi.
const managerAbi = parseAbi([
  "function executeBatch((address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends) permission, (address target,uint256 value,bytes data)[] calls)",
  "function isApproved((address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends) permission) view returns (bool)",
  "function isRevoked((address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends) permission) view returns (bool)",
] as readonly string[]) as Abi;

function clientsForChain(chainId: number, pk: Hex) {
  const account = privateKeyToAccount(pk);
  if (chainId === 84532) {
    const transport = http(
      process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    );
    return {
      pub: createPublicClient({ chain: baseSepolia, transport }),
      wallet: createWalletClient({ account, chain: baseSepolia, transport }),
      account,
    };
  }
  const transport = http(
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  );
  return {
    pub: createPublicClient({ chain: sepolia, transport }),
    wallet: createWalletClient({ account, chain: sepolia, transport }),
    account,
  };
}

/// POST /api/agent-execute { permission, calls, chainId? }
///
/// Server-side bot runner. Signs `manager.executeBatch(permission, calls)`
/// with `BOT_PRIVATE_KEY` and broadcasts on the requested chain. The bot's
/// EOA must match `permission.spender` — the manager rejects otherwise.
///
/// Used by the dashboard's "Execute" button as a no-setup demo path. Real
/// integrations run their own bot (see scripts/bot.ts) with their own key.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      permission?: Record<string, unknown>;
      calls?: Array<{ target: Address; value?: string; data: Hex }>;
      chainId?: number;
    };
    if (!body.permission || !body.calls) {
      return NextResponse.json({ error: "permission and calls required" }, { status: 400 });
    }
    const PK = process.env.BOT_PRIVATE_KEY as Hex | undefined;
    const MANAGER = process.env.NEXT_PUBLIC_MANAGER_ADDRESS as Address | undefined;
    if (!PK) return NextResponse.json({ error: "BOT_PRIVATE_KEY not set" }, { status: 500 });
    if (!MANAGER) return NextResponse.json({ error: "NEXT_PUBLIC_MANAGER_ADDRESS not set" }, { status: 500 });

    // Hydrate stringified bigints back into BigInts.
    const p = body.permission as Record<string, unknown>;
    const permission: Permission = {
      account: p.account as Address,
      spender: p.spender as Address,
      parentNode: p.parentNode as Hex,
      parentTokenId: BigInt(String(p.parentTokenId)),
      label: p.label as string,
      start: Number(p.start),
      end: Number(p.end),
      salt: BigInt(String(p.salt)),
      calls: (p.calls as Array<Record<string, string>>).map((c) => ({
        target: c.target as Address,
        selector: c.selector as Hex,
        checker: c.checker as Address,
      })),
      spends: (p.spends as Array<Record<string, string | number>>).map((s) => ({
        token: s.token as Address,
        allowance: BigInt(String(s.allowance)),
        unit: Number(s.unit),
        multiplier: Number(s.multiplier),
      })),
    };

    const calls: Call[] = body.calls.map((c) => ({
      target: c.target,
      value: c.value ? BigInt(c.value) : 0n,
      data: c.data,
    }));

    const cid = body.chainId ?? 11_155_111;
    const { pub, wallet, account } = clientsForChain(cid, PK);

    if (account.address.toLowerCase() !== permission.spender.toLowerCase()) {
      return NextResponse.json(
        {
          error: `bot key mismatch: backend signs as ${account.address} but permission.spender is ${permission.spender}`,
        },
        { status: 400 },
      );
    }

    console.log("[agent-execute] chain", cid, "bot", account.address);
    console.log("[agent-execute] manager", MANAGER);
    console.log("[agent-execute] permission.account", permission.account);
    console.log("[agent-execute] permission.spender", permission.spender);
    console.log("[agent-execute] calls", calls);

    const [approved, revoked] = await Promise.all([
      pub.readContract({
        address: MANAGER,
        abi: managerAbi,
        functionName: "isApproved",
        args: [permission],
      }),
      pub.readContract({
        address: MANAGER,
        abi: managerAbi,
        functionName: "isRevoked",
        args: [permission],
      }),
    ]);
    console.log("[agent-execute] isApproved", approved, "isRevoked", revoked);
    if (!approved) {
      return NextResponse.json({ error: "permission not approved on-chain" }, { status: 409 });
    }
    if (revoked) {
      return NextResponse.json({ error: "permission revoked" }, { status: 409 });
    }

    // Simulate first so we can surface revert reasons WITHOUT consuming gas.
    let simulationError: string | null = null;
    try {
      await pub.simulateContract({
        address: MANAGER,
        abi: managerAbi,
        functionName: "executeBatch",
        args: [permission, calls],
        account: account.address,
      });
      console.log("[agent-execute] simulation passed");
    } catch (simErr) {
      const e = simErr as {
        shortMessage?: string;
        message?: string;
        cause?: { reason?: string; signature?: string };
        details?: string;
      };
      simulationError = String(
        e?.shortMessage ?? e?.message ?? simErr,
      );
      console.error("[agent-execute] simulation FAILED:", simulationError);
      console.error("[agent-execute] full error:", JSON.stringify(simErr, Object.getOwnPropertyNames(simErr), 2));
      return NextResponse.json(
        { error: simulationError, stage: "simulation" },
        { status: 500 },
      );
    }

    const tx = await wallet.writeContract({
      address: MANAGER,
      abi: managerAbi,
      functionName: "executeBatch",
      args: [permission, calls],
      gas: 800_000n,
    });
    console.log("[agent-execute] submitted", tx);
    const receipt = await pub.waitForTransactionReceipt({ hash: tx });
    console.log(
      "[agent-execute] mined block",
      receipt.blockNumber,
      "status",
      receipt.status,
    );

    if (receipt.status !== "success") {
      return NextResponse.json(
        {
          error: "tx reverted on-chain",
          tx,
          blockNumber: receipt.blockNumber.toString(),
          chainId: cid,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      tx,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      chainId: cid,
    });
  } catch (e) {
    const err = e as {
      shortMessage?: string;
      message?: string;
      details?: string;
      transactionHash?: `0x${string}`;
    };
    console.error("[agent-execute] FAILED:", err?.shortMessage ?? err?.message);
    console.error("[agent-execute] details:", err?.details);
    console.error("[agent-execute] full error:", JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
    return NextResponse.json(
      {
        error: String(err?.shortMessage ?? err?.message ?? err),
        details: err?.details,
        tx: err?.transactionHash ?? null,
      },
      { status: 500 },
    );
  }
}
