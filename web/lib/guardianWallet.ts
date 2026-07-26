/**
 * Guardian-side wallet connection.
 *
 * Note this is the *dApp* side of WalletConnect — ENSign asking a guardian's
 * wallet to sign. That's the opposite of `lib/walletconnect.ts`, which uses
 * WalletKit to make ENSign behave AS a wallet for other dApps. Different
 * packages, different direction; don't merge them.
 *
 * Guardians are often not the account holder and may be on a phone, so QR
 * pairing matters here more than anywhere else in the product.
 */

import type { EIP1193Provider } from "viem";

const PROJECT_ID =
  process.env.NEXT_PUBLIC_PROJECT_ID ??
  process.env.NEXT_PUBLIC_WC_PROJECT_ID ??
  "";

export type Connection = {
  provider: EIP1193Provider;
  address: `0x${string}`;
  via: "injected" | "walletconnect";
};

const CHAIN_META: Record<number, { name: string; rpc: string; explorer: string }> = {
  11155111: {
    name: "Sepolia",
    rpc: process.env.NEXT_PUBLIC_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
  84532: {
    name: "Base Sepolia",
    rpc: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
};

/**
 * Wallets stay on whatever chain the user left them on — usually mainnet — and
 * viem refuses to sign when that disagrees with the client's chain
 * ("Provided chainId 11155111 must match the active chainId 1"). Ask the
 * wallet to move, and offer to add the network if it doesn't know it.
 */
export async function ensureChain(provider: EIP1193Provider, chainId: number): Promise<void> {
  const hex = `0x${chainId.toString(16)}`;
  let current: string;
  try {
    current = (await provider.request({ method: "eth_chainId" })) as string;
  } catch {
    return; // some providers don't expose it; let the sign attempt surface any problem
  }
  if (current?.toLowerCase() === hex.toLowerCase()) return;

  const meta = CHAIN_META[chainId];
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    } as never);
  } catch (e) {
    const code = (e as { code?: number })?.code;
    // 4902: the wallet has never heard of this chain. Anything else is a
    // refusal, and forcing it isn't ours to do.
    if (code !== 4902 || !meta) {
      throw new Error(
        `Please switch your wallet to ${meta?.name ?? `chain ${chainId}`} and try again.`,
      );
    }
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: meta.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [meta.rpc],
        blockExplorerUrls: [meta.explorer],
      }],
    } as never);
  }
}

/** MetaMask and friends — whatever injected itself into the page. */
export async function connectInjected(chainId: number): Promise<Connection> {
  const eth = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) throw new Error("no browser wallet found — install MetaMask or use WalletConnect");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  if (!accounts?.length) throw new Error("wallet returned no accounts");
  await ensureChain(eth, chainId);
  return { provider: eth, address: accounts[0], via: "injected" };
}

/**
 * WalletConnect v2. Opens the QR modal so a guardian can approve from a phone
 * wallet without installing anything on this machine.
 */
export async function connectWalletConnect(chainId: number): Promise<Connection> {
  if (!PROJECT_ID) {
    throw new Error("NEXT_PUBLIC_PROJECT_ID is not set — WalletConnect can't start");
  }
  // Imported lazily: the SDK plus its modal is heavy and most visitors never
  // open it.
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");

  const provider = await EthereumProvider.init({
    projectId: PROJECT_ID,
    // `chains` is a hard requirement the wallet must satisfy; putting the
    // target in `optionalChains` too lets wallets that only advertise mainnet
    // still pair, and we switch them afterwards.
    chains: [chainId],
    optionalChains: [chainId, 1],
    showQrModal: true,
    metadata: {
      name: "ENSign",
      description: "Approve a recovery for an ENSign account",
      url: typeof window !== "undefined" ? window.location.origin : "https://ensign.app",
      icons: ["https://ensign.app/icon.svg"],
    },
  });

  await provider.connect();
  const accounts = provider.accounts as `0x${string}`[];
  if (!accounts?.length) throw new Error("WalletConnect returned no accounts");

  await ensureChain(provider as unknown as EIP1193Provider, chainId);

  return {
    provider: provider as unknown as EIP1193Provider,
    address: accounts[0],
    via: "walletconnect",
  };
}
