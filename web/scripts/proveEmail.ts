/// <reference types="node" />
/**
 * Turn a saved .eml into an EmailProof, using ONLY a prover.
 *
 * No SMTP, no IMAP, no Postgres, no relayer. The guardian sends the approval
 * email from their normal mail client; you save it; this script derives the
 * circuit inputs locally (relayer-utils is WASM, so it runs anywhere), sends
 * them to your prover, and prints the EmailProof JSON to paste into the
 * recovery page's "manual: paste a proof instead" box.
 *
 *   npm i @zk-email/relayer-utils
 *   PROVER_URL=http://YOUR_GPU:3000/api/prove PROVER_API_KEY=... \
 *     npx tsx scripts/proveEmail.ts guardian.eml <accountCode> > proof.json
 *
 * Then check it against the live chain before using it:
 *   npx tsx scripts/checkEmailProof.ts proof.json <account> <nonce> <qx> <qy>
 */

import * as fs from "node:fs";

const PROVER_URL = process.env.PROVER_URL ?? "http://localhost:3000/api/prove";
const PROVER_API_KEY = process.env.PROVER_API_KEY ?? "";
// Must match the zkey your deployed verifier was built from.
const ZKEY_URL = process.env.ZKEY_URL ??
  "https://storage.googleapis.com/circom-ether-email-auth/v2.0.2-dev/circuit_zkey.zip";
const CIRCUIT_URL = process.env.CIRCUIT_URL ??
  "https://storage.googleapis.com/circom-ether-email-auth/v2.0.2-dev/circuit.zip";
const BLUEPRINT_ID = process.env.BLUEPRINT_ID ?? "7f3c3bc2-7c5d-4682-8d7f-f3d2f9046722";

/** snarkjs/rapidsnark emit pi_a/pi_b/pi_c; Solidity wants pi_b's pairs swapped. */
function encodeGroth16(proof: {
  pi_a: string[]; pi_b: string[][]; pi_c: string[];
}): { pA: [string, string]; pB: [[string, string], [string, string]]; pC: [string, string] } {
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    pC: [proof.pi_c[0], proof.pi_c[1]],
  };
}

async function main() {
  const [emlPath, accountCode] = process.argv.slice(2);
  if (!emlPath || !accountCode) {
    console.error("usage: proveEmail.ts <guardian.eml> <accountCode>");
    console.error("  accountCode: the 0x…64-hex code saved when the guardian was registered");
    process.exit(1);
  }

  const utils = await import("@zk-email/relayer-utils");
  const raw = fs.readFileSync(emlPath, "utf8");

  // 1. Parse the email — gives us the DKIM domain, public key and signature.
  const parsed = (await utils.parseEmail(raw)) as {
    canonicalized_header: string;
    signature: number[] | Uint8Array;
    public_key: number[] | Uint8Array;
  };

  // 2. Everything the on-chain struct needs that isn't the proof itself.
  const publicKeyHash = (await utils.publicKeyHash(parsed.public_key)) as string;
  const sig = Uint8Array.from(parsed.signature as number[]);
  const emailNullifier = (await utils.emailNullifier(sig)) as string;
  const accountSalt = (await utils.generateAccountSalt(
    extractFromAddr(raw), accountCode,
  )) as string;

  // 3. Circuit inputs, derived locally from the raw email.
  const inputs = await utils.generateEmailCircuitInput(raw, accountCode, {
    maxHeaderLength: 1024,
    maxBodyLength: 2048,
    ignoreBodyHashCheck: false,
  });

  // 4. Prove — the only step that needs the GPU box.
  const res = await fetch(PROVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PROVER_API_KEY },
    body: JSON.stringify({
      blueprintId: BLUEPRINT_ID,
      proofId: `ensign-${Date.now()}`,
      input: inputs,
      zkeyDownloadUrl: ZKEY_URL,
      circuitCppDownloadUrl: CIRCUIT_URL,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`prover ${res.status}: ${text.slice(0, 300)}`);
  const out = JSON.parse(text) as {
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    publicOutputs?: string[];
  };

  const { pA, pB, pC } = encodeGroth16(out.proof);
  const { encodeAbiParameters } = await import("viem");
  const proofBytes = encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
    [
      [BigInt(pA[0]), BigInt(pA[1])],
      [[BigInt(pB[0][0]), BigInt(pB[0][1])], [BigInt(pB[1][0]), BigInt(pB[1][1])]],
      [BigInt(pC[0]), BigInt(pC[1])],
    ],
  );

  const emailProof = {
    domainName: extractDomain(raw),
    publicKeyHash,
    timestamp: extractTimestamp(raw),
    maskedCommand: extractCommand(raw),
    emailNullifier,
    accountSalt,
    isCodeExist: raw.toLowerCase().includes(accountCode.replace(/^0x/, "").toLowerCase()),
    proof: proofBytes,
  };
  console.log(JSON.stringify(emailProof, null, 2));
}

/** `From:` domain — the DKIM `d=` tag is authoritative, fall back to the address. */
function extractDomain(raw: string): string {
  const d = raw.match(/DKIM-Signature:[\s\S]*?[;\s]d=([^;\s]+)/i);
  if (d) return d[1].trim();
  const f = raw.match(/^From:.*@([A-Za-z0-9.-]+)/im);
  return f ? f[1].replace(/[>,\s]+$/, "") : "";
}

function extractFromAddr(raw: string): string {
  const m = raw.match(/^From:.*?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/im);
  if (!m) throw new Error("could not find a From: address in the .eml");
  return m[1];
}

function extractTimestamp(raw: string): number {
  const m = raw.match(/DKIM-Signature:[\s\S]*?[;\s]t=(\d+)/i);
  if (m) return Number(m[1]);
  const d = raw.match(/^Date:\s*(.+)$/im);
  return d ? Math.floor(new Date(d[1]).getTime() / 1000) : Math.floor(Date.now() / 1000);
}

/** The command the circuit masks out of the body. */
function extractCommand(raw: string): string {
  const m = raw.match(/Recover account 0x[0-9a-fA-F]{40} using recovery hash 0x[0-9a-fA-F]{64}/);
  if (!m) {
    throw new Error(
      "no ENSign command found in the .eml — the email body must contain\n" +
      "  Recover account 0x… using recovery hash 0x…\n" +
      "exactly as shown by the recovery page's 'Show command' button.",
    );
  }
  return m[0];
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
