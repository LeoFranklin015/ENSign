import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  fallback,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

const PK = req("PRIVATE_KEY") as Hex;
export const REGISTRY = req("NEXT_PUBLIC_REGISTRY") as Address;
export const ENTRYPOINT = req("NEXT_PUBLIC_ENTRYPOINT") as Address;

/**
 * RPC has been the single most common cause of production failure on this
 * project: a rate-limited public endpoint, then an Alchemy key that ran out of
 * monthly credits. One provider dying should degrade us, not stop us — so the
 * configured endpoint is tried first and public ones back it up.
 */
const SEPOLIA_FALLBACKS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
];
const BASE_SEPOLIA_FALLBACKS = ["https://sepolia.base.org"];

function transportFor(primary: string | undefined, backups: string[]) {
  const urls = [primary, ...backups].filter(Boolean) as string[];
  // `rank: false` keeps the declared order, so a paid endpoint stays primary
  // and the public ones are only reached when it errors.
  return fallback(
    urls.map((u) => http(u, { timeout: 15_000, retryCount: 2 })),
    { rank: false, retryCount: 1 },
  );
}

const sepoliaTransport = transportFor(process.env.SEPOLIA_RPC_URL, SEPOLIA_FALLBACKS);
const baseTransport = transportFor(process.env.BASE_SEPOLIA_RPC_URL, BASE_SEPOLIA_FALLBACKS);

/**
 * Reads may rotate between providers freely. Writes may not: sending
 * consecutive transactions through different nodes strands a nonce in a
 * mempool that never sees the gap filled, and the transaction is dropped. So
 * the wallet pins one endpoint and only falls back if it is unreachable.
 */
function writeTransport(primary: string | undefined, backups: string[]) {
  const first = (primary ?? backups[0]) as string;
  return http(first, { timeout: 20_000, retryCount: 3, retryDelay: 400 });
}

const sepoliaWriteTransport = writeTransport(process.env.SEPOLIA_RPC_URL, SEPOLIA_FALLBACKS);
const baseWriteTransport = writeTransport(process.env.BASE_SEPOLIA_RPC_URL, BASE_SEPOLIA_FALLBACKS);

export const account = privateKeyToAccount(PK);

const sepoliaPub = createPublicClient({ chain: sepolia, transport: sepoliaTransport });

/**
 * Receipt polling MUST use the same node the transaction was broadcast to.
 * Through a rotating fallback the poll can land on a provider that has never
 * seen the hash, so it waits forever on a transaction that already confirmed
 * somewhere else — which reads as "timed out while waiting for transaction".
 */
export const txPub = createPublicClient({ chain: sepolia, transport: sepoliaWriteTransport });
const sepoliaWallet = createWalletClient({ account, chain: sepolia, transport: sepoliaWriteTransport });
const basePub = createPublicClient({ chain: baseSepolia, transport: baseTransport });
const baseWallet = createWalletClient({ account, chain: baseSepolia, transport: baseWriteTransport });

export function clientsForChain(chainId: number | string | undefined) {
  if (Number(chainId) === 84532) {
    return { pub: basePub, wallet: baseWallet, chain: "base-sepolia" as const };
  }
  return { pub: sepoliaPub, wallet: sepoliaWallet, chain: "sepolia" as const };
}

/// Default Sepolia clients for endpoints that aren't chain-parameterised yet.
export const pub = sepoliaPub;
export const wallet = sepoliaWallet;

// Wrapper interface. `predictAccount` is keyed off the passkey coordinates
// (canonical factory derivation), not the label.
export const registryAbi = parseAbi([
  "function register(string,bytes32,bytes32,string,uint64) returns (uint256,address)",
  "function predictAccount(bytes32,bytes32) view returns (address)",
  "function getResolver(string) view returns (address)",
]);

// Canonical SmartAccountFactory — same address on every chain.
export const SMART_ACCOUNT_FACTORY: Address =
  "0x5803c076563C85799989d42Fc00292A8aE52fa9E";

export const factoryAbi = parseAbi([
  "function getAddress(bytes[] owners, uint256 nonce) view returns (address)",
]);

export function ownersFor(qx: Hex, qy: Hex): Hex[] {
  return [encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]) as Hex];
}

export const epAbi = parseAbi([
  "function depositTo(address) payable",
  "function balanceOf(address) view returns (uint256)",
]);
