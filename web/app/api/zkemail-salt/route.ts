import { NextResponse } from "next/server";
import { relayerUtils } from "@/lib/relayerUtils";

/**
 * Derive a zkEmail accountSalt = Poseidon(emailAddress, accountCode).
 *
 * Computed locally with relayer-utils (WASM) rather than calling a hosted
 * relayer: it's the same function, needs no network, and removes a CORS/uptime
 * dependency from guardian registration.
 */
export async function POST(req: Request) {
  try {
    const { emailAddress, accountCode } = (await req.json()) as {
      emailAddress?: string;
      accountCode?: string;
    };
    if (!emailAddress || !accountCode) {
      return NextResponse.json(
        { error: "emailAddress and accountCode are required" },
        { status: 400 },
      );
    }
    if (accountCode.length !== 66 || !accountCode.startsWith("0x")) {
      return NextResponse.json(
        { error: `account code must be 0x + 64 hex, got ${accountCode.length} chars` },
        { status: 400 },
      );
    }

    const utils = await relayerUtils();
    const accountSalt = (await utils.generateAccountSalt(
      emailAddress,
      accountCode,
    )) as string;

    return NextResponse.json({ accountSalt, emailAddress, accountCode });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 400 },
    );
  }
}
