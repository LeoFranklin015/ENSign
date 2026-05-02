import { NextResponse } from "next/server";
import type { Hex } from "viem";
import { factoryAbi, ownersFor, pub, SMART_ACCOUNT_FACTORY } from "@/lib/clients";

export async function POST(req: Request) {
  try {
    const { qx, qy } = (await req.json()) as { qx?: Hex; qy?: Hex };
    if (!qx || !qy) {
      return NextResponse.json({ error: "qx, qy required" }, { status: 400 });
    }
    const addr = await pub.readContract({
      address: SMART_ACCOUNT_FACTORY,
      abi: factoryAbi,
      functionName: "getAddress",
      args: [ownersFor(qx, qy), 0n],
    });
    return NextResponse.json({ account: addr });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 400 },
    );
  }
}
