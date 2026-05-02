// ENSign frontend helpers.
//
// Source-of-truth model: ENS records, not browser storage.
//
//   name "alice" + parent "looooo.eth"
//     → namehash → registry.addr(node) → JAW account address
//     → JAW.ownerAtIndex(0)            → passkey public key (qx ‖ qy)
//
// We never store credentialIds or pubkeys client-side. At sign time the browser
// surfaces a discoverable passkey for the user to pick (resident keys, empty
// `allowCredentials`), and the JAW verifies on-chain that the signature came
// from the expected key.

import {
  createPublicClient,
  http,
  parseAbi,
  encodeAbiParameters,
  encodeFunctionData,
  stringToHex,
  padHex,
  numberToHex,
  hexToBytes,
  bytesToHex,
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

export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});

/// Public client for whichever chain the dApp is signing on.
export function clientForChain(chainId: number) {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    return createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC_URL) });
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
// UserOp building
// ---------------------------------------------------------------------------

export type BuiltUserOp = {
  sender: `0x${string}`;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export async function buildExecuteUserOp(opts: {
  account: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  data?: Hex;
  chainId?: number;
  initCode?: Hex;
}): Promise<BuiltUserOp> {
  const callData = encodeFunctionData({
    abi: jawAbi,
    functionName: "execute",
    args: [opts.target, opts.value, opts.data ?? "0x"],
  });

  const client = clientForChain(opts.chainId ?? CHAIN_ID);
  const nonce = await client.readContract({
    address: ENTRYPOINT,
    abi: entryPointAbi,
    functionName: "getNonce",
    args: [opts.account, 0n],
  });

  const verificationGasLimit = 1_000_000n;
  const callGasLimit = 200_000n;
  const preVerificationGas = 200_000n;
  const maxPriorityFeePerGas = 1_000_000_000n;
  const maxFeePerGas = 3_000_000_000n;

  return {
    sender: opts.account,
    nonce,
    initCode: opts.initCode ?? "0x",
    callData,
    accountGasLimits: pack(verificationGasLimit, callGasLimit),
    preVerificationGas,
    gasFees: pack(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

export async function getUserOpHash(op: BuiltUserOp, chainId?: number): Promise<Hex> {
  const client = clientForChain(chainId ?? CHAIN_ID);
  return client.readContract({
    address: ENTRYPOINT,
    abi: entryPointAbi,
    functionName: "getUserOpHash",
    args: [
      [
        op.sender,
        op.nonce,
        op.initCode,
        op.callData,
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        op.paymasterAndData,
        op.signature,
      ],
    ],
  });
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

/// Sign with the passkey bound to the given name. If `credentialId` is provided,
/// the browser is told to use exactly that passkey — no chooser, straight to
/// Face ID. If empty, falls back to discoverable mode (browser shows chooser).
export async function signUserOpHashForName(
  hash: Hex,
  credentialId: string,
): Promise<Hex> {
  const challenge = hexToBytes(hash);

  const allowCredentials = credentialId
    ? [{
        id: base64UrlToBytes(credentialId),
        type: "public-key" as const,
        transports: ["internal", "hybrid"] as AuthenticatorTransport[],
      }]
    : [];

  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: window.location.hostname,
      userVerification: "required",
      timeout: 60_000,
      allowCredentials,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey prompt cancelled");

  const response = cred.response as AuthenticatorAssertionResponse;
  const authenticatorData = bytesToHex(new Uint8Array(response.authenticatorData));
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
  const sigDer = new Uint8Array(response.signature);

  const { r, s } = parseDerEcdsa(sigDer);
  const sNorm = lowS(s);

  const challengeIndex = BigInt(clientDataJSON.indexOf('"challenge"'));
  const typeIndex = BigInt(clientDataJSON.indexOf('"type"'));

  const webAuthnAuth = encodeAbiParameters(
    [
      {
        components: [
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "bytes" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
        type: "tuple",
      },
    ],
    [
      {
        authenticatorData,
        clientDataJSON: stringToHex(clientDataJSON),
        challengeIndex,
        typeIndex,
        r: padHex(numberToHex(r), { size: 32 }),
        s: padHex(numberToHex(sNorm), { size: 32 }),
      },
    ],
  );

  return encodeAbiParameters(
    [
      {
        components: [
          { name: "ownerIndex", type: "uint256" },
          { name: "signatureData", type: "bytes" },
        ],
        type: "tuple",
      },
    ],
    [{ ownerIndex: 0n, signatureData: webAuthnAuth }],
  );
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export async function relayUserOp(op: BuiltUserOp, chainId?: number): Promise<{
  tx: Hex;
  success: boolean;
  blockNumber: string;
  gasUsed: string;
  status?: string;
  error?: string;
}> {
  const res = await fetch("/api/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainId: chainId ?? CHAIN_ID,
      userOp: {
        ...op,
        nonce: op.nonce.toString(),
        preVerificationGas: op.preVerificationGas.toString(),
      },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `relay failed: ${res.status}`);
  return json;
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
