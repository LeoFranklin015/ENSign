import { NextResponse } from "next/server";
import { getDb, type PermissionDoc } from "@/lib/mongo";

/// PATCH /api/permissions/:hash  body { account, revokeTxHash }
/// Mark a permission as revoked in the local cache after the on-chain
/// revoke tx confirms. Authoritative state is `manager.isRevoked` —
/// this just helps the UI render an accurate list without a second
/// chain round-trip.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ hash: string }> },
) {
  try {
    const { hash } = await ctx.params;
    const body = (await req.json()) as {
      account?: `0x${string}`;
      revokeTxHash?: `0x${string}`;
    };
    if (!body.account) {
      return NextResponse.json({ error: "account required" }, { status: 400 });
    }
    const db = await getDb();
    const result = await db.collection<PermissionDoc>("permissions").updateOne(
      {
        userAccount: body.account.toLowerCase() as `0x${string}`,
        permissionHash: hash as `0x${string}`,
      },
      {
        $set: {
          revokedAt: new Date().toISOString(),
          revokeTxHash: body.revokeTxHash ?? null,
        },
      },
    );
    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? String(e) }, { status: 500 });
  }
}
