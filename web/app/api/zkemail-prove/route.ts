import { NextResponse } from "next/server";
import { encodeAbiParameters, type Hex } from "viem";
import { relayerUtils } from "@/lib/relayerUtils";

/**
 * Turn a raw .eml into an EmailProof, server-side.
 *
 * The guardian's email never needs to pass through zkEmail's relayer: the
 * circuit inputs are derived here with relayer-utils (WASM), sent to a prover
 * we control, and assembled into the struct `ZkEmailRecoveryProvider.verify`
 * expects. Keeping this on the server also keeps `PROVER_API_KEY` out of the
 * browser bundle.
 *
 * Env (server-only, no NEXT_PUBLIC_ prefix):
 *   PROVER_URL      e.g. http://your-gpu-box:3000/api/prove
 *   PROVER_API_KEY  the API_KEY the prover was started with
 *   ZKEY_URL / CIRCUIT_URL / BLUEPRINT_ID   (optional overrides)
 */

const PROVER_URL = process.env.PROVER_URL ?? "";
const PROVER_API_KEY = process.env.PROVER_API_KEY ?? "";
const ZKEY_URL = process.env.ZKEY_URL ??
  "https://storage.googleapis.com/circom-ether-email-auth/v2.0.2-dev/circuit_zkey.zip";
const CIRCUIT_URL = process.env.CIRCUIT_URL ??
  "https://storage.googleapis.com/circom-ether-email-auth/v2.0.2-dev/circuit.zip";
const BLUEPRINT_ID = process.env.BLUEPRINT_ID ?? "7f3c3bc2-7c5d-4682-8d7f-f3d2f9046722";

/** The exact line the guardian's email must carry. */
const COMMAND_RE =
  /Recover account 0x[0-9a-fA-F]{40} using recovery hash 0x[0-9a-fA-F]{64}/;

function fromAddr(raw: string): string {
  const m = raw.match(/^From:.*?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/im);
  if (!m) throw new Error("no From: address found in the .eml");
  return m[1];
}

function dkimDomain(raw: string): string {
  const d = raw.match(/DKIM-Signature:[\s\S]*?[;\s]d=([^;\s]+)/i);
  if (d) return d[1].trim();
  const f = raw.match(/^From:.*@([A-Za-z0-9.-]+)/im);
  return f ? f[1].replace(/[>,\s]+$/, "") : "";
}

function dkimTimestamp(raw: string): number {
  const m = raw.match(/DKIM-Signature:[\s\S]*?[;\s]t=(\d+)/i);
  if (m) return Number(m[1]);
  const d = raw.match(/^Date:\s*(.+)$/im);
  return d ? Math.floor(new Date(d[1]).getTime() / 1000) : Math.floor(Date.now() / 1000);
}

export async function POST(req: Request) {
  try {
    const { eml, accountCode } = (await req.json()) as {
      eml?: string;
      accountCode?: string;
    };
    if (!eml || !accountCode) {
      return NextResponse.json({ error: "eml and accountCode are required" }, { status: 400 });
    }
    const command = eml.match(COMMAND_RE)?.[0];
    if (!command) {
      return NextResponse.json(
        {
          error:
            "no ENSign command found in the email body. It must contain exactly the line " +
            "shown by 'Show command', e.g. 'Recover account 0x… using recovery hash 0x…'.",
        },
        { status: 400 },
      );
    }

    if (!PROVER_URL) {
      return NextResponse.json(
        { error: "PROVER_URL is not set on the server (.env.local, no NEXT_PUBLIC_ prefix)" },
        { status: 500 },
      );
    }

    const utils = await relayerUtils();

    // Parse once: gives us the DKIM public key and signature.
    const parsed = (await utils.parseEmail(eml)) as {
      signature: number[];
      public_key: number[];
    };
    const publicKeyHash = (await utils.publicKeyHash(parsed.public_key)) as string;
    const emailNullifier = (await utils.emailNullifier(
      Uint8Array.from(parsed.signature),
    )) as string;
    const accountSalt = (await utils.generateAccountSalt(
      fromAddr(eml),
      accountCode,
    )) as string;

    // Derive circuit inputs locally, then prove remotely.
    const input = await utils.generateEmailCircuitInput(eml, accountCode, {
      maxHeaderLength: 1024,
      maxBodyLength: 2048,
      ignoreBodyHashCheck: false,
    });

    const res = await fetch(PROVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": PROVER_API_KEY,
        // ngrok's free tier otherwise answers with an HTML interstitial.
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({
        blueprintId: BLUEPRINT_ID,
        proofId: `ensign-${Date.now()}`,
        input,
        zkeyDownloadUrl: ZKEY_URL,
        circuitCppDownloadUrl: CIRCUIT_URL,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `prover ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const out = JSON.parse(text) as {
      proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    };

    // Solidity's pairing check wants each pi_b pair swapped.
    const p = out.proof;
    const proofBytes = encodeAbiParameters(
      [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
      [
        [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
        [
          [BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])],
          [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])],
        ],
        [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
      ],
    ) as Hex;

    return NextResponse.json({
      proof: {
        domainName: dkimDomain(eml),
        publicKeyHash,
        timestamp: dkimTimestamp(eml),
        maskedCommand: command,
        emailNullifier,
        accountSalt,
        isCodeExist: eml
          .toLowerCase()
          .includes(accountCode.replace(/^0x/, "").toLowerCase()),
        proof: proofBytes,
      },
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 400 },
    );
  }
}
