import { NextResponse } from "next/server";

import { parseEther, type Hex } from "viem";
import {
  ENTRYPOINT,
  REGISTRY,
  SMART_ACCOUNT_FACTORY,
  epAbi,
  factoryAbi,
  ownersFor,
  pub,
  registryAbi,
  txPub,
  wallet,
} from "@/lib/serverClients";

// These broadcast transactions and wait on receipts, which outlives the
// default serverless limit. Hosts that honour this (Vercel) will allow it;
// others ignore it harmlessly.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

type RegisterBody = {
  label?: string;
  qx?: Hex;
  qy?: Hex;
  credentialId?: string;
};

export async function POST(req: Request) {
  try {
    const { label, qx, qy, credentialId } = (await req.json()) as RegisterBody;
    if (!label || !qx || !qy) {
      return NextResponse.json({ error: "label, qx, qy required" }, { status: 400 });
    }

    const credId = typeof credentialId === "string" ? credentialId : "";
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);

    const predicted = (await pub.readContract({
      address: SMART_ACCOUNT_FACTORY,
      abi: factoryAbi,
      functionName: "getAddress",
      args: [ownersFor(qx, qy), 0n],
    })) as `0x${string}`;

    // Ordering matters more than parallelism here.
    //
    // A previous version assigned nonces by hand and fired all three at once.
    // Across a fallback transport consecutive sends can reach *different* RPC
    // providers, so a manually-numbered transaction sits in one node's mempool
    // behind a gap it never sees filled, and is eventually dropped. Let viem
    // manage nonces, and put the only transaction the caller depends on first.
    const registerTx = await wallet.writeContract({
      address: REGISTRY,
      abi: registryAbi,
      functionName: "register",
      args: [label, qx, qy, credId, expiry],
    });

    let blockNumber: string | null = null;
    try {
      // Same node that accepted the broadcast, and long enough for a slow
      // Sepolia block. maxDuration is 60s, so stay inside it.
      const receipt = await txPub.waitForTransactionReceipt({
        hash: registerTx,
        timeout: 50_000,
        pollingInterval: 2_000,
      });
      blockNumber = receipt.blockNumber.toString();
    } catch {
      // Broadcast succeeded; the wait didn't. The name still lands a block or
      // two later, so hand back the hash rather than failing a registration
      // that is already on its way.
      blockNumber = null;
    }

    // Funding follows. Neither is needed for the name to exist, so we only
    // await the broadcast, never the receipt.
    let depositTx: Hex | null = null;
    let fundTx: Hex | null = null;
    try {
      depositTx = await wallet.writeContract({
        address: ENTRYPOINT,
        abi: epAbi,
        functionName: "depositTo",
        args: [predicted],
        value: parseEther("0.005"),
      });
      fundTx = await wallet.sendTransaction({
        to: predicted,
        value: parseEther("0.0001"),
      });
    } catch (fundErr) {
      // The account exists either way; it just can't pay for a UserOp yet.
      console.error("register: funding failed", fundErr);
    }

    return NextResponse.json({
      account: predicted,
      registerTx,
      depositTx,
      fundTx,
      blockNumber,
      pending: blockNumber === null,
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string; details?: string; cause?: unknown };
    console.error("register failed", e);
    // viem's `shortMessage` is often just "RPC Request failed.", which says
    // nothing. Include the details and cause so a deployed failure is
    // diagnosable from the response alone.
    const cause = err?.cause as { shortMessage?: string; message?: string } | undefined;
    const parts = [
      err?.shortMessage ?? err?.message,
      err?.details,
      cause?.shortMessage ?? cause?.message,
    ].filter(Boolean);
    return NextResponse.json(
      { error: parts.join(" · ").slice(0, 400) || String(e) },
      { status: 500 },
    );
  }
}
