/**
 * Guardian-side wallet connection.
 *
 * Note this is the *dApp* side of WalletConnect — ENSign asking a guardian's
 * wallet to sign. That's the opposite of `lib/walletconnect.ts`, which uses
 * WalletKit to make ENSign behave AS a wallet for other dApps. Different
 * packages, different direction; don't merge them.
 *
 * Guardians are often not the account holder and may be on a phone, so QR
 * pairing matters here more than it does anywhere else in the product.
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

/** MetaMask and friends — whatever injected itself into the page. */
export async function connectInjected(): Promise<Connection> {
  const eth = (globalThis as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) throw new Error("no browser wallet found — install MetaMask or use WalletConnect");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  if (!accounts?.length) throw new Error("wallet returned no accounts");
  return { provider: eth, address: accounts[0], via: "injected" };
}

/**
 * WalletConnect v2. Opens their QR modal so a guardian can approve from a
 * phone wallet without installing anything on this machine.
 */
export async function connectWalletConnect(chainId: number): Promise<Connection> {
  if (!PROJECT_ID) {
    throw new Error("NEXT_PUBLIC_PROJECT_ID is not set — WalletConnect can't start");
  }
  // Imported lazily: the SDK is heavy and most visitors never open it.
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");

  const provider = await EthereumProvider.init({
    projectId: PROJECT_ID,
    chains: [chainId],
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

  return {
    provider: provider as unknown as EIP1193Provider,
    address: accounts[0],
    via: "walletconnect",
  };
}
