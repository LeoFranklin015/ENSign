import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
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
export const REGISTRY = req("REGISTRY") as Address;
export const ENTRYPOINT = req("ENTRYPOINT") as Address;

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

export const account = privateKeyToAccount(PK);

const sepoliaPub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const sepoliaWallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
const basePub = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });
const baseWallet = createWalletClient({ account, chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });

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
  "function handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)",
]);

/// Topic hash of EntryPoint's `UserOperationEvent`.
export const USER_OP_EVENT_TOPIC: Hex =
  "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
