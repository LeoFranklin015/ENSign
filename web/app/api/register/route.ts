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

    // Three sequential transactions each awaiting a receipt is ~36s on
    // Sepolia's block time — past a serverless function's limit, which
    // surfaces as an aborted RPC call rather than a timeout. Nonces are
    // assigned up front so all three can be broadcast back to back, and only
    // the one the caller actually depends on is awaited.
    let nonce = await pub.getTransactionCount({
      address: wallet.account!.address,
      blockTag: "pending",
    });

    // Pre-fund the EntryPoint deposit so the smart account can pay UserOp gas.
    const depositTx = await wallet.writeContract({
      address: ENTRYPOINT,
      abi: epAbi,
      functionName: "depositTo",
      args: [predicted],
      value: parseEther("0.005"),
      nonce: nonce++,
    });

    // Tiny direct balance so the account can do small `value:` transfers.
    const fundTx = await wallet.sendTransaction({
      to: predicted,
      value: parseEther("0.0001"),
      nonce: nonce++,
    });

    const registerTx = await wallet.writeContract({
      address: REGISTRY,
      abi: registryAbi,
      functionName: "register",
      args: [label, qx, qy, credId, expiry],
      nonce: nonce++,
    });

    // Only this one gates the response: the client needs the name to exist.
    // The funding transactions land in the same block or the next.
    const receipt = await pub.waitForTransactionReceipt({
      hash: registerTx,
      timeout: 45_000,
    });

    return NextResponse.json({
      account: predicted,
      registerTx,
      depositTx,
      fundTx,
      blockNumber: receipt.blockNumber.toString(),
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
