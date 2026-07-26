// ENSign frontend helpers.
//
// Source-of-truth model: ENS records, not browser storage.
//
//   name "alice" + parent "ensign.eth"
//     → namehash → registry.addr(node) → JAW account address
//     → JAW.ownerAtIndex(0)            → passkey public key (qx ‖ qy)
//
// We never store credentialIds or pubkeys client-side. At sign time the browser
// surfaces a discoverable passkey for the user to pick (resident keys, empty
// `allowCredentials`), and the JAW verifies on-chain that the signature came
// from the expected key.

import {
  createPublicClient,
  fallback,
  http,
  parseAbi,
  encodeAbiParameters,
  encodeFunctionData,
  stringToHex,
  padHex,
  numberToHex,
  hexToBytes,
  bytesToHex,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import {
  createWebAuthnCredential,
} from "viem/account-abstraction";
import { baseSepolia, sepolia } from "viem/chains";
import { namehash } from "viem/ens";
import * as PublicKey from "ox/PublicKey";

export const REGISTRY = process.env.NEXT_PUBLIC_REGISTRY as `0x${string}`;
export const ENTRYPOINT = process.env.NEXT_PUBLIC_ENTRYPOINT as `0x${string}`;
export const PARENT_NAME = process.env.NEXT_PUBLIC_PARENT_NAME as string;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL as string;
export const BASE_SEPOLIA_RPC_URL = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL as string;
export const PIMLICO_KEY = process.env.NEXT_PUBLIC_PIMLICO_KEY as string;
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "11155111");

/// Pimlico bundler URL for any chainId. Free tier covers Sepolia + Base Sepolia.
export function bundlerUrl(chainId: number): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${PIMLICO_KEY}`;
}
export const CHAIN = CHAIN_ID === 84532 ? baseSepolia : sepolia;
export const CHAIN_ID_HEX = ("0x" + CHAIN_ID.toString(16)) as Hex;

export const SEPOLIA_CHAIN_ID = 11155111;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/// Canonical JustanAccount factory deployed via Safe Singleton — same address on every chain.
/// `factory.getAddress([abi.encode(qx,qy)], nonce)` returns the deterministic JAW address.
export const JAW_FACTORY: `0x${string}` = "0x5803c076563C85799989d42Fc00292A8aE52fa9E";

export const jawFactoryAbi = parseAbi([
  "function getAddress(bytes[] owners, uint256 nonce) view returns (address)",
  "function createAccount(bytes[] owners, uint256 nonce) payable returns (address)",
]);

/**
 * Browser-side reads. Same reasoning as lib/serverClients: a single provider
 * running out of credits or throttling shouldn't break the app, so the
 * configured endpoint leads and public ones back it up. `rank: false` keeps a
 * paid endpoint primary instead of latency-sorting it away.
 */
const PUBLIC_FALLBACKS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
];

function readTransport(primary: string | undefined, backups: string[]) {
  const urls = [primary, ...backups].filter(Boolean) as string[];
  return fallback(
    urls.map((u) => http(u, { timeout: 12_000, retryCount: 2 })),
    { rank: false, retryCount: 1 },
  );
}

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: readTransport(RPC_URL, PUBLIC_FALLBACKS),
});

/// Public client for whichever chain the dApp is signing on.
export function clientForChain(chainId: number) {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    return createPublicClient({
      chain: baseSepolia,
      transport: readTransport(BASE_SEPOLIA_RPC_URL, ["https://sepolia.base.org"]),
    });
  }
  return publicClient;
}

// Wrapper interface. Records live on a per-subname PermissionedResolver proxy
// — call `getResolver(label)` to find it, then read records from there.
export const registryAbi = parseAbi([
  "function predictAccount(bytes32,bytes32) view returns (address)",
  "function getResolver(string) view returns (address)",
  "function ownerOf(uint256) view returns (address)",
]);

export const resolverAbi = parseAbi([
  "function addr(bytes32) view returns (address)",
  "function text(bytes32,string) view returns (string)",
]);

export const jawAbi = parseAbi([
  "function execute(address,uint256,bytes)",
  "function nextOwnerIndex() view returns (uint256)",
  "function ownerAtIndex(uint256) view returns (bytes)",
  "function isOwnerPublicKey(bytes32,bytes32) view returns (bool)",
]);

export const entryPointAbi = parseAbi([
  "function getNonce(address,uint192) view returns (uint256)",
  "function getUserOpHash((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)) view returns (bytes32)",
  "function balanceOf(address) view returns (uint256)",
]);

const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const lowS = (s: bigint) => (s > N / 2n ? N - s : s);

const pack = (hi: bigint, lo: bigint) =>
  ("0x" +
    hi.toString(16).padStart(32, "0") +
    lo.toString(16).padStart(32, "0")) as Hex;

// ---------------------------------------------------------------------------
// Pubkey helpers
// ---------------------------------------------------------------------------

export function splitPublicKey(publicKey: Hex): { qx: Hex; qy: Hex } {
  const pk = PublicKey.fromHex(publicKey);
  const x = (pk.x as bigint).toString(16).padStart(64, "0");
  const y = (pk.y as bigint).toString(16).padStart(64, "0");
  return { qx: ("0x" + x) as Hex, qy: ("0x" + y) as Hex };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/// Creates a discoverable WebAuthn credential (resident key). Returns the
/// credential's pubkey AND its base64url id. Both get written on-chain so that
/// the registry holds enough state to address this exact passkey later.
export async function createPasskeyForLabel(
  label: string,
): Promise<{ qx: Hex; qy: Hex; credentialId: string }> {
  const credential = await createWebAuthnCredential({
    name: `${label}.${PARENT_NAME}`,
  });
  const { qx, qy } = splitPublicKey(credential.publicKey);
  return { qx, qy, credentialId: credential.id };
}

export async function registerName(
  label: string,
  qx: Hex,
  qy: Hex,
  credentialId: string,
): Promise<{ account: `0x${string}`; registerTx: Hex; blockNumber: string }> {
  const res = await fetch("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, qx, qy, credentialId }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`/api/register: ${res.status} ${t}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// ENS lookup
// ---------------------------------------------------------------------------

export type ResolvedName = {
  fullName: string;
  account: `0x${string}`;
  qx: Hex;
  qy: Hex;
  /// Base64url-encoded WebAuthn credentialId, or empty if not stored on-chain
  /// (e.g. names registered before the text-record upgrade). Empty → fall back
  /// to the OS passkey chooser.
  credentialId: string;
};

/// Resolves a label to its JAW account, on-chain passkey, and credentialId,
/// all from ENS state. No localStorage, no credential cache — pure read from chain.
export async function resolveLabel(label: string): Promise<ResolvedName> {
  const fullName = `${label}.${PARENT_NAME}`;
  const node = namehash(fullName);

  // The wrapper points each subname at its own resolver proxy. Find it, then
  // read records from there.
  const resolver = await publicClient.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "getResolver",
    args: [label],
  });

  if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${fullName} is not registered yet`);
  }

  const [account, credentialId] = await Promise.all([
    publicClient.readContract({
      address: resolver,
      abi: resolverAbi,
      functionName: "addr",
      args: [node],
    }),
    publicClient.readContract({
      address: resolver,
      abi: resolverAbi,
      functionName: "text",
      args: [node, "credentialId"],
    }).catch(() => ""),
  ]);

  if (!account || account === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${fullName} is not registered yet`);
  }

  // ownerAtIndex(0) returns abi.encode(qx, qy) — 64 bytes.
  const ownerBytes = await publicClient.readContract({
    address: account,
    abi: jawAbi,
    functionName: "ownerAtIndex",
    args: [0n],
  });
  if (ownerBytes.length !== 130) {
    throw new Error(`unexpected owner format on ${fullName}: ${ownerBytes}`);
  }
  const qx = ("0x" + ownerBytes.slice(2, 66)) as Hex;
  const qy = ("0x" + ownerBytes.slice(66, 130)) as Hex;

  return { fullName, account, qx, qy, credentialId: credentialId || "" };
}

// ---------------------------------------------------------------------------
// Discoverable passkey signing — empty allowCredentials triggers the browser's
// passkey chooser so the user picks the right name.
// ---------------------------------------------------------------------------

/// Parse a DER-encoded ECDSA signature into (r, s) bigints. WebAuthn assertions
/// return DER; we strip leading zero pads added for two's complement.
function parseDerEcdsa(sig: Uint8Array): { r: bigint; s: bigint } {
  if (sig[0] !== 0x30) throw new Error("DER: expected SEQUENCE");
  let i = 2; // skip 0x30 + total length
  if (sig[i] !== 0x02) throw new Error("DER: expected INTEGER for r");
  const rLen = sig[i + 1];
  let rBytes = sig.slice(i + 2, i + 2 + rLen);
  while (rBytes.length > 1 && rBytes[0] === 0) rBytes = rBytes.slice(1);
  i = i + 2 + rLen;
  if (sig[i] !== 0x02) throw new Error("DER: expected INTEGER for s");
  const sLen = sig[i + 1];
  let sBytes = sig.slice(i + 2, i + 2 + sLen);
  while (sBytes.length > 1 && sBytes[0] === 0) sBytes = sBytes.slice(1);
  return {
    r: BigInt(bytesToHex(rBytes)),
    s: BigInt(bytesToHex(sBytes)),
  };
}

/// Decodes a base64url string to bytes (no padding). Browser-only.
function base64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// Storage proxy that holds the actual subname tokens (the canonical UserRegistry
/// proxy that `ensign.eth` points at). Used for direct ownership checks when
/// the resolver pointer hasn't been set yet.
const STORAGE_REGISTRY: Address = "0x674cBe3246596871f18B2fe3489E09D77734fE06";

const storageRegistryAbi = parseAbi([
  "function getTokenId(uint256) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
]);

export type LabelStatus =
  | { state: "free" }
  | { state: "taken"; account: `0x${string}`; hasResolver: true; credentialId: string }
  | { state: "taken"; account: `0x${string}`; hasResolver: false; credentialId: null };

/// Authoritative availability check for a label under PARENT_NAME.
///
/// Two on-chain paths to "taken":
///   1. `resolveLabel` succeeds → resolver + records present → can sign in.
///   2. `resolveLabel` fails (no resolver) BUT the storage proxy has the
///      token minted → still taken, but the resolver was never wired so
///      the user can't sign in. Picking it fresh would revert the wrapper
///      with `LabelAlreadyRegistered`. Block it.
export async function checkLabel(label: string): Promise<LabelStatus> {
  // Path 1 — full resolution.
  try {
    const r = await resolveLabel(label);
    return {
      state: "taken",
      account: r.account,
      hasResolver: true,
      credentialId: r.credentialId,
    };
  } catch {
    // fall through
  }

  // Path 2 — storage-proxy ownership check.
  try {
    const labelHash = BigInt(keccak256(toBytes(label)));
    const tokenId = (await publicClient.readContract({
      address: STORAGE_REGISTRY,
      abi: storageRegistryAbi,
      functionName: "getTokenId",
      args: [labelHash],
    })) as bigint;
    if (tokenId === 0n) return { state: "free" };
    const owner = (await publicClient.readContract({
      address: STORAGE_REGISTRY,
      abi: storageRegistryAbi,
      functionName: "ownerOf",
      args: [tokenId],
    })) as `0x${string}`;
    if (owner === "0x0000000000000000000000000000000000000000") {
      return { state: "free" };
    }
    return { state: "taken", account: owner, hasResolver: false, credentialId: null };
  } catch {
    // Token not minted (ownerOf reverts on unknown id).
    return { state: "free" };
  }
}

/// Prove ownership of a passkey by exercising it against a random challenge.
/// Used at "sign in" time to verify the user actually has the credential
/// before saving a session for that name. Throws if the user cancels or the
/// authenticator can't find the credential.
export async function verifyPasskey(credentialId: string): Promise<boolean> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: window.location.hostname,
      userVerification: "required",
      timeout: 60_000,
      allowCredentials: [
        {
          id: base64UrlToBytes(credentialId),
          type: "public-key" as const,
          transports: ["internal", "hybrid"] as AuthenticatorTransport[],
        },
      ],
    },
  })) as PublicKeyCredential | null;
  return !!cred;
}

// ---------------------------------------------------------------------------
// Submission via viem's bundler client + Pimlico paymaster
// ---------------------------------------------------------------------------

/// Pimlico sponsorship policy. Identifies which gas budget to bill against
/// when calling `pm_*`. The paymaster address is returned in the RPC response
/// (not hardcoded here).
const SPONSORSHIP_POLICY_ID = "sp_nice_the_fallen";

/// One-call send: build → sponsor → sign → submit → wait, all driven by
/// viem's `bundlerClient.sendUserOperation`. The paymaster wrapper handles
/// Pimlico's bogus-gas-limit quirk.
///
/// Pass either a single `target/value/data` or a `calls` array for batched
/// execution (uses the smart account's `executeBatch` under the hood).
/// Ask the Pimlico bundler what it will actually accept right now. Returns
/// undefined if the endpoint is unavailable, so callers can fall back to
/// viem's own estimation rather than failing outright.
async function pimlicoGasPrice(
  chainId: number,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined> {
  try {
    const res = await fetch(bundlerUrl(chainId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "pimlico_getUserOperationGasPrice",
        params: [],
      }),
    });
    const json = (await res.json()) as {
      result?: { fast?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
    };
    const fast = json.result?.fast;
    if (!fast) return undefined;
    return {
      maxFeePerGas: BigInt(fast.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(fast.maxPriorityFeePerGas),
    };
  } catch {
    return undefined;
  }
}

export async function sendUserOp(opts: {
  account: `0x${string}`;
  credentialId: string;
  target?: `0x${string}`;
  value?: bigint;
  data?: Hex;
  calls?: Array<{ to: `0x${string}`; value?: bigint; data?: Hex }>;
  chainId?: number;
}): Promise<{ tx: Hex; success: boolean; blockNumber: string; gasUsed: string }> {
  const { createBundlerClient, createPaymasterClient } = await import(
    "viem/account-abstraction"
  );
  const { http } = await import("viem");
  const { toEnsignAccount } = await import("./ensignAccount");
  const { createPaymasterFunctions } = await import("./paymasterFns");

  const cid = opts.chainId ?? CHAIN_ID;
  const client = clientForChain(cid);

  // viem's `toSmartAccount` and `createBundlerClient` infer slightly
  // different `Client` shapes — same runtime type, but TS won't unify them.
  // Casting to `any` here is safe and keeps the public surface clean.
  const smartAccount = await toEnsignAccount({
    client: client as never,
    account: opts.account,
    credentialId: opts.credentialId,
  });

  const paymasterClient = createPaymasterClient({
    transport: http(bundlerUrl(cid)),
  });

  const bundlerClient = createBundlerClient({
    client: client as never,
    transport: http(bundlerUrl(cid)),
    paymaster: createPaymasterFunctions(client as never, paymasterClient, cid, {
      sponsorshipPolicyId: SPONSORSHIP_POLICY_ID,
    }) as never,
  });

  const calls =
    opts.calls && opts.calls.length > 0
      ? opts.calls.map((c) => ({
          to: c.to,
          value: c.value ?? 0n,
          data: c.data ?? ("0x" as Hex),
        }))
      : [
          {
            to: opts.target as `0x${string}`,
            value: opts.value ?? 0n,
            data: opts.data ?? ("0x" as Hex),
          },
        ];
  if (!opts.calls && !opts.target) {
    throw new Error("sendUserOp: must provide either `target` or `calls`");
  }

  // Pimlico enforces its own floor on maxPriorityFeePerGas and rejects the
  // value viem derives from the RPC ("Invalid fields set on User Operation").
  // Always take the bundler's own quote; fall back to viem's estimate only if
  // the call fails.
  const fees = await pimlicoGasPrice(cid);

  const userOpHash = await bundlerClient.sendUserOperation({
    account: smartAccount,
    calls,
    ...(fees ?? {}),
  });

  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
  return {
    tx: receipt.receipt.transactionHash,
    success: receipt.success,
    blockNumber: receipt.receipt.blockNumber.toString(),
    gasUsed: receipt.actualGasUsed.toString(),
  };
}

// ---------------------------------------------------------------------------
// Cross-chain JAW lookup (factory-derived, deterministic)
// ---------------------------------------------------------------------------

/// Compute the JustanAccountFactory-derived JAW address for a passkey.
/// Same address on any chain that has the factory at `0x5803c076…`.
export async function predictFactoryJaw(
  qx: Hex,
  qy: Hex,
  nonce: bigint = 0n,
  chainId: number = SEPOLIA_CHAIN_ID,
): Promise<`0x${string}`> {
  const client = clientForChain(chainId);
  const owners: Hex[] = [encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]) as Hex];
  return client.readContract({
    address: JAW_FACTORY,
    abi: jawFactoryAbi,
    functionName: "getAddress",
    args: [owners, nonce],
  });
}

/// Build the `initCode` to deploy the factory-derived JAW lazily inside a UserOp.
/// EntryPoint will call `factory.createAccount(owners, nonce)` before validation.
export function jawDeployInitCode(qx: Hex, qy: Hex, nonce: bigint = 0n): Hex {
  const owners: Hex[] = [encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]) as Hex];
  const inner = encodeFunctionData({
    abi: jawFactoryAbi,
    functionName: "createAccount",
    args: [owners, nonce],
  });
  return (JAW_FACTORY + inner.slice(2)) as Hex;
}

/// Return true if the JAW at this address has bytecode on the given chain.
export async function isJawDeployed(account: `0x${string}`, chainId: number): Promise<boolean> {
  const client = clientForChain(chainId);
  const code = await client.getCode({ address: account });
  return !!code && code !== "0x";
}

// ---------------------------------------------------------------------------
// Primary name (ENS reverse record)
//
// The ENSv2 staging deployment (sepolia-official-v1-20260525-r2) ships no v2
// reverse registrar. Its RootRegistry resolves the `reverse` label through
// ENSV1Resolver, which bridges every `*.addr.reverse` lookup to the existing
// Sepolia v1 ReverseRegistrar. So: writes go to the v1 registrar (below),
// reads come back through the staging UniversalResolverV2, which also
// forward-verifies the name against our v2 subname records.
//
// Staging redeploys can rewire this — cross-check the deployment artifacts
// in ensdomains/contracts-v2 (see docs/ENSv2-RUNBOOK.md) if reads go dark.
// ---------------------------------------------------------------------------

/// Sepolia v1 ReverseRegistrar. `setName(string)` claims `<caller>.addr.reverse`,
/// points it at the default reverse resolver, and writes the name — one call.
/// msg.sender-authorized, so the JAW itself must send it (via sendUserOp).
export const REVERSE_REGISTRAR: Address =
  "0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6";

/// UniversalResolverV2 from the staging deployment — the read path.
export const UNIVERSAL_RESOLVER_V2: Address =
  "0x2f8a180604c42457cb56c7c4f708748ff1f91df1";

export const reverseRegistrarAbi = parseAbi([
  "function setName(string name) returns (bytes32)",
]);

const universalResolverV2Abi = parseAbi([
  "function reverse(bytes lookupAddress, uint256 coinType) view returns (string name, address resolver, address reverseResolver)",
]);

/// Primary name for an address, or null when unset. Also null when the
/// UniversalResolver reverts (failed forward-verification) or the RPC is
/// down — callers only need "show ✓" vs "show the button". Never throws.
export async function getPrimaryName(addr: Address): Promise<string | null> {
  try {
    const [name] = await publicClient.readContract({
      address: UNIVERSAL_RESOLVER_V2,
      abi: universalResolverV2Abi,
      functionName: "reverse",
      args: [addr, 60n],
    });
    return name || null;
  } catch {
    return null;
  }
}

/// Calldata for ReverseRegistrar.setName(fullName). Send from the JAW:
/// sendUserOp({ account, credentialId, target: REVERSE_REGISTRAR, data: ... }).
export function setPrimaryNameData(fullName: string): Hex {
  return encodeFunctionData({
    abi: reverseRegistrarAbi,
    functionName: "setName",
    args: [fullName],
  });
}
