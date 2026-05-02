// WalletConnect (Reown / WalletKit) integration. Same-origin web app:
//   * the page itself is the WC peer (paste/scan WC URI, approve sessions)
//   * Face ID prompts run on the same origin so the passkey is reachable
//   * each `eth_sendTransaction` is translated into a JAW UserOp + relayed
//
// The dApp doesn't need any ENSign SDK — it just uses WalletConnect (most
// modern dApps already do via AppKit / RainbowKit / Web3Modal).

import { Core } from "@walletconnect/core";
import { WalletKit, type IWalletKit } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import {
  hexToBytes,
  bytesToHex,
  type Hex,
} from "viem";

import {
  buildExecuteUserOp,
  getUserOpHash,
  relayUserOp,
  resolveLabel,
  signUserOpHashForName,
} from "./ensign";

const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string;
const CHAIN = "eip155:11155111"; // Sepolia
const SUPPORTED_METHODS = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_chainId",
  "eth_accounts",
];
const SUPPORTED_EVENTS = ["accountsChanged", "chainChanged"];

let _walletKit: IWalletKit | null = null;
let _initPromise: Promise<IWalletKit> | null = null;

export async function getWalletKit(): Promise<IWalletKit> {
  if (_walletKit) return _walletKit;
  if (_initPromise) return _initPromise;
  if (!PROJECT_ID) {
    throw new Error(
      "VITE_WC_PROJECT_ID is empty — grab a free one at https://cloud.reown.com",
    );
  }
  _initPromise = (async () => {
    const core = new Core({ projectId: PROJECT_ID });
    const wk = await WalletKit.init({
      core,
      metadata: {
        name: "ENSign",
        description: "Sign with ENS. Subname is the wallet.",
        url: window.location.origin,
        icons: [`${window.location.origin}/vite.svg`],
      },
    });
    _walletKit = wk;
    return wk;
  })();
  return _initPromise;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export async function pair(uri: string): Promise<void> {
  const wk = await getWalletKit();
  await wk.pair({ uri });
}

export async function approveProposal(
  proposalId: number,
  jawAddress: `0x${string}`,
): Promise<void> {
  const wk = await getWalletKit();
  // The proposal lives in walletKit state; fetch it. The struct shape varies
  // between SDK versions; we only need the namespace fields walletKit uses for
  // approval, so cast through unknown.
  const proposals = wk.getPendingSessionProposals();
  const raw = Object.values(proposals).find(
    (p) => (p as unknown as { id: number }).id === proposalId,
  ) as unknown as { params: Parameters<typeof buildApprovedNamespaces>[0]["proposal"] } | undefined;
  if (!raw) throw new Error(`No pending proposal with id ${proposalId}`);

  const namespaces = buildApprovedNamespaces({
    proposal: raw.params,
    supportedNamespaces: {
      eip155: {
        chains: [CHAIN],
        methods: SUPPORTED_METHODS,
        events: SUPPORTED_EVENTS,
        accounts: [`${CHAIN}:${jawAddress}`],
      },
    },
  });

  await wk.approveSession({ id: proposalId, namespaces });
}

export async function rejectProposal(proposalId: number): Promise<void> {
  const wk = await getWalletKit();
  await wk.rejectSession({
    id: proposalId,
    reason: getSdkError("USER_REJECTED"),
  });
}

export async function disconnectSession(topic: string): Promise<void> {
  const wk = await getWalletKit();
  await wk.disconnectSession({
    topic,
    reason: getSdkError("USER_DISCONNECTED"),
  });
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export type SignContext = {
  label: string; // ENS label whose JAW signs (e.g. "ricky")
  account: `0x${string}`; // resolved JAW address
  credentialId: string; // base64url credential id from ENS text record
};

/// Translate a WalletConnect request into a signed/relayed result. Routes:
/// - `eth_sendTransaction` → build UserOp on the JAW, Face ID, relay handleOps,
///   return the on-chain tx hash.
/// - `personal_sign` / `eth_signTypedData_v4` → not yet implemented (Solady
///   ERC-7739 nested EIP-712 wrapping required); rejects with a clear error.
/// - `eth_chainId` / `eth_accounts` → answered locally.
export async function handleRequest(
  ev: { topic: string; params: { request: { method: string; params: unknown[] } }; id: number },
  ctx: SignContext,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const method = ev.params.request.method;
  const params = ev.params.request.params;

  if (method === "eth_chainId") {
    return { result: "0xaa36a7" }; // 11155111 hex
  }
  if (method === "eth_accounts") {
    return { result: [ctx.account] };
  }

  if (method === "eth_sendTransaction") {
    const tx = params[0] as {
      to: `0x${string}`;
      value?: `0x${string}` | string;
      data?: Hex;
    };
    if (!tx?.to) {
      return { error: { code: -32602, message: "missing `to`" } };
    }
    const value = tx.value
      ? typeof tx.value === "string"
        ? BigInt(tx.value)
        : 0n
      : 0n;

    const userOp = await buildExecuteUserOp({
      account: ctx.account,
      target: tx.to,
      value,
      data: (tx.data ?? "0x") as Hex,
    });
    const hash = await getUserOpHash(userOp);
    const sig = await signUserOpHashForName(hash, ctx.credentialId);
    userOp.signature = sig;

    const relay = await relayUserOp(userOp);
    if (!relay.success) {
      return {
        error: {
          code: -32603,
          message: `UserOp failed (tx ${relay.tx})`,
        },
      };
    }
    return { result: relay.tx };
  }

  if (method === "personal_sign" || method === "eth_signTypedData_v4") {
    return {
      error: {
        code: -32601,
        message: `${method} not yet supported on ENSign (V1 ships eth_sendTransaction only)`,
      },
    };
  }

  return {
    error: { code: -32601, message: `method not supported: ${method}` },
  };
}

export async function respondSuccess(
  topic: string,
  id: number,
  result: unknown,
): Promise<void> {
  const wk = await getWalletKit();
  await wk.respondSessionRequest({
    topic,
    response: { id, jsonrpc: "2.0", result },
  });
}

export async function respondError(
  topic: string,
  id: number,
  err: { code: number; message: string },
): Promise<void> {
  const wk = await getWalletKit();
  await wk.respondSessionRequest({
    topic,
    response: {
      id,
      jsonrpc: "2.0",
      error: err,
    },
  });
}

export async function listActiveSessions() {
  const wk = await getWalletKit();
  return Object.values(wk.getActiveSessions());
}

// Re-export for direct use
export { resolveLabel };
export type { IWalletKit };
// Avoid TS warning about unused imports
void hexToBytes;
void bytesToHex;
