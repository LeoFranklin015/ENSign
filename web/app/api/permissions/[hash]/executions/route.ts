import { NextResponse } from "next/server";
import { getDb, type PermissionDoc } from "@/lib/mongo";

/// POST /api/permissions/:hash/executions
/// Append a tx record to the permission's execution history.
/// Body: { account, txHash, blockNumber, target, value, selector? }
export async function POST(
  req: Request,
  ctx: { params: Promise<{ hash: string }> },
) {
  try {
    const { hash } = await ctx.params;
    const body = (await req.json()) as {
      account?: `0x${string}`;
      txHash?: `0x${string}`;
      blockNumber?: string;
      target?: `0x${string}`;
      value?: string;
      selector?: `0x${string}`;
    };
    if (!body.account || !body.txHash) {
      return NextResponse.json(
        { error: "account and txHash required" },
        { status: 400 },
      );
    }
    const db = await getDb();
    const result = await db.collection<PermissionDoc>("permissions").updateOne(
      {
        userAccount: body.account.toLowerCase() as `0x${string}`,
        permissionHash: hash as `0x${string}`,
      },
      {
        $push: {
          executions: {
            txHash: body.txHash,
            blockNumber: body.blockNumber ?? "0",
            target: (body.target ?? "0x0") as `0x${string}`,
            value: body.value ?? "0",
            selector: body.selector ?? null,
            at: new Date().toISOString(),
          },
        },
      },
    );
    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "permission not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? String(e) }, { status: 500 });
  }
}
