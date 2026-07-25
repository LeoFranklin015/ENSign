/**
 * Verifies the primary-name helpers against live Sepolia state.
 *
 *   1. The ensign.eth deployer EOA already has a primary name set through
 *      the v1 bridge — getPrimaryName must return "ensign.eth".
 *   2. A burn address has no reverse record — getPrimaryName must return null.
 *   3. setPrimaryNameData must produce byte-identical calldata to
 *      `cast calldata "setName(string)" "test.ensign.eth"`.
 *
 * Run:
 *   cd web
 *   npx tsx scripts/checkPrimaryName.ts
 */

import fs from "node:fs";
import path from "node:path";

function loadEnv(p: string) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv(path.resolve(".env.local"));
loadEnv(path.resolve(".env"));

async function main() {
  // Import AFTER env is loaded — ensign.ts reads NEXT_PUBLIC_RPC_URL at module load.
  const { getPrimaryName, setPrimaryNameData } = await import("../lib/ensign");

  const withName = await getPrimaryName(
    "0xE08224B2CfaF4f27E2DC7cB3f6B99AcC68Cf06c0",
  );
  if (withName !== "ensign.eth") {
    throw new Error(`expected "ensign.eth" for deployer EOA, got: ${withName}`);
  }
  console.log("✓ reverse read through UniversalResolverV2:", withName);

  const withoutName = await getPrimaryName(
    "0x0000000000000000000000000000000000000001",
  );
  if (withoutName !== null) {
    throw new Error(`expected null for unset address, got: ${withoutName}`);
  }
  console.log("✓ unset address returns null");

  const expected =
    "0xc47f00270000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f746573742e656e7369676e2e6574680000000000000000000000000000000000";
  const data = setPrimaryNameData("test.ensign.eth");
  if (data !== expected) {
    throw new Error(`setName calldata mismatch:\n  got:      ${data}\n  expected: ${expected}`);
  }
  console.log("✓ setName calldata matches cast");

  console.log("all checks passed");
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
