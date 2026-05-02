import { NextResponse } from "next/server";
import { account, pub, REGISTRY } from "@/lib/serverClients";

export async function GET() {
  const block = await pub.getBlockNumber();
  return NextResponse.json({
    relayer: account.address,
    block: block.toString(),
    registry: REGISTRY,
  });
}
