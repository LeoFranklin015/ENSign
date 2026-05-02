import { NextResponse } from "next/server";
import { getDb, type PermissionDoc } from "@/lib/mongo";

/// GET /api/permissions?account=0x…&chainId=11155111
/// List all permissions stored for a user (both active and revoked).
/// On-chain `isApproved` / `isRevoked` is the source of truth — clients
/// should re-verify status against the manager contract.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const account = url.searchParams.get("account") as `0x${string}` | null;
    const chainId = Number(url.searchParams.get("chainId") || "11155111");
    if (!account) {
      return NextResponse.json({ error: "account required" }, { status: 400 });
    }
    const db = await getDb();
    const docs = await db
      .collection<PermissionDoc>("permissions")
      .find({ userAccount: account.toLowerCase() as `0x${string}`, chainId })
      .sort({ createdAt: -1 })
      .toArray();
    // strip _id so the client-side type stays clean
    return NextResponse.json({
      permissions: docs.map(({ _id: _omit, ...rest }) => rest),
    });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? String(e) }, { status: 500 });
  }
}

/// POST /api/permissions { permission: PermissionDoc (without revokedAt/revokeTxHash) }
/// Save a freshly-minted permission. Idempotent on (userAccount, permissionHash).
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<PermissionDoc>;
    const required = ["userAccount", "chainId", "permissionHash", "spender", "label", "createTxHash"] as const;
    for (const f of required) {
      if (body[f] === undefined || body[f] === null) {
        return NextResponse.json({ error: `missing field: ${f}` }, { status: 400 });
      }
    }
    const doc: PermissionDoc = {
      userAccount: (body.userAccount as string).toLowerCase() as `0x${string}`,
      chainId: body.chainId!,
      permissionHash: body.permissionHash!,
      spender: (body.spender as string).toLowerCase() as `0x${string}`,
      label: body.label!,
      parentNode: body.parentNode!,
      parentTokenId: body.parentTokenId ?? "0",
      start: body.start ?? 0,
      end: body.end ?? 0,
      salt: body.salt ?? "0",
      calls: body.calls ?? [],
      spends: body.spends ?? [],
      createdAt: new Date().toISOString(),
      createTxHash: body.createTxHash!,
      revokedAt: null,
      revokeTxHash: null,
    };
    const db = await getDb();
    await db.collection<PermissionDoc>("permissions").updateOne(
      { userAccount: doc.userAccount, permissionHash: doc.permissionHash },
      { $set: doc },
      { upsert: true },
    );
    return NextResponse.json({ ok: true, permission: doc });
  } catch (e) {
    const err = e as { message?: string };
    return NextResponse.json({ error: err?.message ?? String(e) }, { status: 500 });
  }
}
