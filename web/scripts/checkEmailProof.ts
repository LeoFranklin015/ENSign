/// <reference types="node" />
/**
 * Check a zkEmail EmailProof against the LIVE Sepolia stack, in isolation.
 *
 * When a self-hosted prover returns a proof, three things can be wrong and the
 * on-chain revert looks the same for all of them. This separates them:
 *
 *   1. the zkey doesn't match the deployed verifier's verification key
 *      (the most likely failure — Sepolia and Base Sepolia ship DIFFERENT keys)
 *   2. the DKIM public key isn't registered for the sender's domain
 *   3. the command text doesn't match what our provider expects
 *
 * Usage:
 *   npx tsx scripts/checkEmailProof.ts proof.json <account> <nonce> <qx> <qy>
 *
 * where proof.json is the `response.proof` object from the relayer's
 * GET /api/status/:id.
 */

import { createPublicClient, http, encodeAbiParameters, parseAbi, type Hex } from "viem";
import { sepolia } from "viem/chains";
import * as fs from "node:fs";

const RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ZK_VERIFIER = "0x3E5f29a7cCeb30D5FCD90078430CA110c2985716" as const;
const DKIM_REGISTRY = "0x3D3935B3C030893f118a84C92C66dF1B9E4169d6" as const;
const PROVIDER = (process.env.NEXT_PUBLIC_ZKEMAIL_PROVIDER ??
  "0x3AB8722fb2abF3875560c9bd4C3c932dEeF50397") as `0x${string}`;

const EMAIL_PROOF_TUPLE = {
  type: "tuple",
  components: [
    { name: "domainName", type: "string" },
    { name: "publicKeyHash", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
    { name: "maskedCommand", type: "string" },
    { name: "emailNullifier", type: "bytes32" },
    { name: "accountSalt", type: "bytes32" },
    { name: "isCodeExist", type: "bool" },
    { name: "proof", type: "bytes" },
  ],
} as const;

const verifierAbi = [{
  type: "function", name: "verifyEmailProof", stateMutability: "view",
  inputs: [EMAIL_PROOF_TUPLE], outputs: [{ type: "bool" }],
}] as const;

const providerAbi = parseAbi([
  "function expectedCommand(address account, uint256 nonce, bytes subject) pure returns (string)",
  "function verify(address account, bytes subject, uint256 nonce, bytes commitment, bytes proof) view",
]);

async function main() {
  const [file, account, nonceStr, qx, qy] = process.argv.slice(2);
  if (!file || !account || !nonceStr || !qx || !qy) {
    console.error("usage: checkEmailProof.ts proof.json <account> <nonce> <qx> <qy>");
    process.exit(1);
  }
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  const client = createPublicClient({ chain: sepolia, transport: http(RPC) });

  const proof = {
    domainName: p.domainName,
    publicKeyHash: p.publicKeyHash as Hex,
    timestamp: BigInt(p.timestamp),
    maskedCommand: p.maskedCommand,
    emailNullifier: p.emailNullifier as Hex,
    accountSalt: p.accountSalt as Hex,
    isCodeExist: Boolean(p.isCodeExist),
    proof: p.proof as Hex,
  };

  console.log("proof from email:");
  console.log("  domain        ", proof.domainName);
  console.log("  accountSalt   ", proof.accountSalt);
  console.log("  maskedCommand ", JSON.stringify(proof.maskedCommand));
  console.log();

  // ── 1. the Groth16 check, straight against the deployed verifier ──
  let vkOk = false;
  try {
    vkOk = (await client.readContract({
      address: ZK_VERIFIER, abi: verifierAbi, functionName: "verifyEmailProof", args: [proof],
    })) as boolean;
    console.log(vkOk
      ? "1. Groth16 ............ PASS (zkey matches the deployed verification key)"
      : "1. Groth16 ............ FAIL (returned false)");
  } catch (e) {
    console.log("1. Groth16 ............ REVERTED:", (e as Error).message.split("\n")[0]);
  }
  if (!vkOk) {
    console.log("   -> Your zkey almost certainly does not match Sepolia's verifier.");
    console.log("      Sepolia and Base Sepolia ship different verification keys.");
    console.log("      Fix: deploy a Verifier built from YOUR zkey and point a new");
    console.log("      ZkEmailRecoveryProvider at it (the address is a constructor arg).");
  }

  // ── 2. DKIM key registered for the domain ──
  const probeAbi = parseAbi(["function isDKIMPublicKeyHashValid(string,bytes32) view returns (bool)"]);
  try {
    // Called from the provider so the registry's Ownable(msg.sender).owner() works.
    const dkimOk = (await client.readContract({
      address: DKIM_REGISTRY, abi: probeAbi, functionName: "isDKIMPublicKeyHashValid",
      args: [proof.domainName, proof.publicKeyHash], account: PROVIDER,
    })) as boolean;
    console.log(dkimOk
      ? "2. DKIM key ........... PASS"
      : `2. DKIM key ........... FAIL (${proof.domainName} / ${proof.publicKeyHash} not registered)`);
  } catch (e) {
    console.log("2. DKIM key ........... could not read:", (e as Error).message.split("\n")[0]);
  }

  // ── 3. command binding ──
  const subject = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }], [qx as Hex, qy as Hex],
  );
  const expected = (await client.readContract({
    address: PROVIDER, abi: providerAbi, functionName: "expectedCommand",
    args: [account as `0x${string}`, BigInt(nonceStr), subject],
  })) as string;
  const match = expected.toLowerCase() === proof.maskedCommand.trim().toLowerCase();
  console.log(match ? "3. Command ............ PASS" : "3. Command ............ MISMATCH");
  if (!match) {
    console.log("   expected:", JSON.stringify(expected));
    console.log("   in email:", JSON.stringify(proof.maskedCommand));
  }

  // ── 4. the whole provider path ──
  const commitment = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "string" }], [proof.accountSalt, proof.domainName],
  );
  const encoded = encodeAbiParameters([EMAIL_PROOF_TUPLE], [proof]);
  try {
    await client.readContract({
      address: PROVIDER, abi: providerAbi, functionName: "verify",
      args: [account as `0x${string}`, subject, BigInt(nonceStr), commitment, encoded],
    });
    console.log("4. Provider.verify .... PASS — this proof will work in requestRecovery");
  } catch (e) {
    console.log("4. Provider.verify .... FAIL:", (e as Error).message.split("\n")[0]);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
