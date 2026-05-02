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

    // Pre-fund the EntryPoint deposit so the smart account can pay UserOp gas.
    const depositTx = await wallet.writeContract({
      address: ENTRYPOINT,
      abi: epAbi,
      functionName: "depositTo",
      args: [predicted],
      value: parseEther("0.005"),
    });
    await pub.waitForTransactionReceipt({ hash: depositTx });

    // Tiny direct balance so the account can do small `value:` transfers.
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

    return NextResponse.json({
      account: predicted,
      registerTx,
      depositTx,
      fundTx,
      blockNumber: receipt.blockNumber.toString(),
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    console.error("register failed", e);
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 500 },
    );
  }
}
