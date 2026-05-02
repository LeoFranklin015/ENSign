"use client";


// ENSign embed surface. Loaded inside an iframe on any dApp page (by the
// bookmarklet's `connector.js`). Communicates with the parent via postMessage:
//
//   parent → embed:  { kind: "rpc", id, method, params }
//   embed → parent:  { kind: "rpc-result", id, result } | { kind: "rpc-result", id, error }
//   embed → parent:  { kind: "show", visible }     — toggle iframe visibility
//   embed → parent:  { kind: "event", event, payload }  — accountsChanged, etc.
//
// The embed lives on our origin so passkeys + WebAuthn work normally.
import { useEffect, useRef, useState } from "react";
import "../app/embed/embed.css";
import {
  BASE_SEPOLIA_CHAIN_ID,
  CHAIN_ID_HEX,
  PARENT_NAME,
  SEPOLIA_CHAIN_ID,
  bundlerUrl,
  clientForChain,
  predictFactoryJaw,
  resolveLabel,
} from "@/lib/ensign";
import { toENSignAccount } from "@/lib/toENSignAccount";
import { decodeTx, formatTokenAmount, type DecodeResult } from "@/lib/decodeTx";
import { http, formatEther, type Hex } from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import {
  ArrowRight,
  Send,
  Code2,
  KeyRound,
} from "lucide-react";

type Account = {
  label: string;
  fullName: string;
  /// Per-chain JAW address.
  /// - Sepolia: registry-derived (resolved via ENS `addr(node)`)
  /// - Base Sepolia: factory-derived (from canonical JustanAccountFactory)
  addresses: Record<number, `0x${string}`>;
  qx: Hex;
  qy: Hex;
  credentialId: string;
};

type RpcRequest = {
  id: number | string;
  method: string;
  params: unknown[];
};

type Pending = RpcRequest;

/// Chains we can actually relay transactions on. Other chains are permitted to
/// connect/switch (we emit events normally) but `eth_sendTransaction` rejects.
const RELAYABLE_CHAIN_IDS = new Set([SEPOLIA_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID]);
const PASSTHROUGH_BLOCKLIST = new Set([
  "eth_requestAccounts",
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_requestPermissions",
  "wallet_getPermissions",
]);

function buildEthAccountsPermission(address: `0x${string}`) {
  return {
    parentCapability: "eth_accounts",
    caveats: [
      {
        type: "restrictReturnedAccounts",
        value: [address],
      },
    ],
    date: Date.now(),
  };
}

export default function Embed() {
  const [account, setAccount] = useState<Account | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsAccountFor, setNeedsAccountFor] = useState<Pending | null>(null);
  const [pendingTx, setPendingTx] = useState<{
    req: Pending;
    to: `0x${string}`;
    value: bigint;
    data: Hex;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSign, setPendingSign] = useState<{
    req: Pending;
    kind: "personal_sign" | "eth_signTypedData_v4";
  } | null>(null);
  const accountRef = useRef<Account | null>(null);
  const chainIdRef = useRef<string>(CHAIN_ID_HEX);
  accountRef.current = account;

  function send(parent: Window, msg: unknown) {
    parent.postMessage(msg, "*");
  }

  function setVisible(visible: boolean) {
    window.parent.postMessage({ kind: "show", visible }, "*");
  }

  function respondResult(id: number | string, result: unknown) {
    window.parent.postMessage({ kind: "rpc-result", id, result }, "*");
  }
  function respondError(id: number | string, code: number, message: string) {
    window.parent.postMessage(
      { kind: "rpc-result", id, error: { code, message } },
      "*",
    );
  }

  // Boot: announce ready, register message listener.
  useEffect(() => {
    send(window.parent, { kind: "ready" });

    function onMessage(e: MessageEvent) {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.kind === "close-request") {
        handleClose();
        return;
      }
      if (msg.kind !== "rpc") return;
      const req = msg as RpcRequest;
      handleRpc(req).catch((err) => {
        console.error(err);
        respondError(req.id, -32603, (err as Error).message ?? "internal");
        setVisible(false);
      });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// Closes the modal and rejects whichever pending request gated it.
  function handleClose() {
    if (busy) return; // don't close mid-sign
    if (pendingTx) {
      respondError(pendingTx.req.id, 4001, "user rejected");
      setPendingTx(null);
    }
    if (pendingSign) {
      respondError(pendingSign.req.id, 4001, "user rejected");
      setPendingSign(null);
    }
    if (needsAccountFor) {
      respondError(needsAccountFor.id, 4001, "user rejected");
      setNeedsAccountFor(null);
    }
    setError(null);
    setVisible(false);
  }

  async function handleRpc(req: RpcRequest) {
    if (req.method === "eth_chainId") {
      respondResult(req.id, chainIdRef.current);
      return;
    }
    if (req.method === "net_version") {
      respondResult(req.id, BigInt(chainIdRef.current).toString(10));
      return;
    }
    if (req.method === "eth_accounts") {
      const acc = accountRef.current;
      respondResult(req.id, acc ? [addressForChain(acc, parseInt(chainIdRef.current, 16))] : []);
      return;
    }
    if (req.method === "eth_coinbase") {
      const acc = accountRef.current;
      respondResult(req.id, acc ? addressForChain(acc, parseInt(chainIdRef.current, 16)) : null);
      return;
    }
    if (req.method === "eth_requestAccounts") {
      if (accountRef.current) {
        const addr = addressForChain(accountRef.current, parseInt(chainIdRef.current, 16));
        window.parent.postMessage(
          { kind: "event", event: "accountsChanged", payload: [addr] },
          "*",
        );
        window.parent.postMessage(
          { kind: "event", event: "chainChanged", payload: chainIdRef.current },
          "*",
        );
        window.parent.postMessage(
          { kind: "event", event: "connect", payload: { chainId: chainIdRef.current } },
          "*",
        );
        respondResult(req.id, [addr]);
        return;
      }
      setNeedsAccountFor(req);
      setVisible(true);
      return;
    }
    // `eth_estimateGas` from the dApp is asking "how much gas for this tx
    // from the JAW account?". The chain RPC can't answer that meaningfully
    // because the JAW isn't an EOA and may not be deployed on this chain yet.
    // Route through the bundler's `eth_estimateUserOperationGas` which knows
    // about smart accounts.
    if (req.method === "eth_estimateGas") {
      try {
        const chainId = parseInt(chainIdRef.current, 16);
        if (!RELAYABLE_CHAIN_IDS.has(chainId) || !accountRef.current) {
          // No bundler configured for this chain; let the chain answer.
          const fallback = await clientForChain(chainId).request({
            method: "eth_estimateGas",
            params: req.params,
          } as never);
          respondResult(req.id, fallback);
          return;
        }
        const tx = (req.params[0] ?? {}) as { to?: `0x${string}`; value?: string; data?: Hex };
        if (!tx.to) {
          respondError(req.id, -32602, "missing `to`");
          return;
        }
        const client = clientForChain(chainId);
        const smartAccount = await toENSignAccount({
          client,
          label: accountRef.current.label,
          chainId,
        });
        const bundler = createBundlerClient({
          client,
          transport: http(bundlerUrl(chainId)),
          account: smartAccount,
        });
        const gas = await bundler.estimateUserOperationGas({
          calls: [
            {
              to: tx.to,
              value: tx.value ? BigInt(tx.value) : 0n,
              data: (tx.data ?? "0x") as Hex,
            },
          ],
        });
        const total =
          (gas.callGasLimit ?? 0n) +
          (gas.verificationGasLimit ?? 0n) +
          (gas.preVerificationGas ?? 0n);
        respondResult(req.id, "0x" + total.toString(16));
      } catch (e) {
        respondError(req.id, -32603, (e as Error).message || "estimate failed");
      }
      return;
    }
    // Fee-related RPCs: just forward to the chain RPC. Public node answers
    // correctly. No hardcoded values.
    if (
      req.method === "eth_gasPrice" ||
      req.method === "eth_maxPriorityFeePerGas" ||
      req.method === "eth_feeHistory" ||
      req.method === "eth_blockNumber" ||
      req.method === "eth_getBlockByNumber" ||
      req.method === "eth_getBlockByHash"
    ) {
      try {
        const client = clientForChain(parseInt(chainIdRef.current, 16));
        const result = await client.request({
          method: req.method as never,
          params: req.params as never,
        });
        respondResult(req.id, result);
      } catch (e) {
        respondError(req.id, -32603, (e as Error).message || `${req.method} failed`);
      }
      return;
    }
    if (req.method === "eth_call") {
      // Forward eth_call but rewrite `from` to a non-empty EOA so chains that
      // require a sender with code don't choke on our undeployed JAW. Many
      // dApps use eth_call with `from` set for permission checks; rewriting
      // is fine for read-only simulation.
      try {
        const client = clientForChain(parseInt(chainIdRef.current, 16));
        const original = (req.params[0] ?? {}) as { from?: string };
        const sanitised = { ...original };
        if (
          accountRef.current &&
          original.from &&
          original.from.toLowerCase() ===
            addressForChain(accountRef.current, parseInt(chainIdRef.current, 16)).toLowerCase()
        ) {
          // Drop the from override; let the chain assume the zero address.
          delete sanitised.from;
        }
        const result = await client.request({
          method: "eth_call",
          params: [sanitised, req.params[1] ?? "latest"],
        } as never);
        respondResult(req.id, result);
      } catch (e) {
        respondError(req.id, -32603, (e as Error).message || "eth_call failed");
      }
      return;
    }

    if (req.method === "eth_sendTransaction") {
      if (!accountRef.current) {
        setNeedsAccountFor(req);
        setVisible(true);
        return;
      }
      const chainId = parseInt(chainIdRef.current, 16);
      if (!RELAYABLE_CHAIN_IDS.has(chainId)) {
        respondError(
          req.id,
          4901,
          `ENSign can't relay on chain ${chainIdRef.current} (${chainId}). Switch to Sepolia (0xaa36a7) or Base Sepolia (0x14a34).`,
        );
        return;
      }
      const tx = (req.params[0] ?? {}) as {
        to?: `0x${string}`;
        value?: string;
        data?: Hex;
      };
      if (!tx.to) {
        respondError(req.id, -32602, "missing `to`");
        return;
      }
      const value = tx.value ? BigInt(tx.value) : 0n;
      setPendingTx({ req, to: tx.to, value, data: (tx.data ?? "0x") as Hex });
      setVisible(true);
      return;
    }
    if (req.method === "personal_sign" || req.method === "eth_signTypedData_v4") {
      if (!accountRef.current) {
        setNeedsAccountFor(req);
        setVisible(true);
        return;
      }
      // Stage as a pending sign request; user confirms with Face ID. The smart
      // account adapter handles the ERC-7739 nested EIP-712 wrapping under the
      // hood so the resulting signature passes the JAW's `isValidSignature`
      // (ERC-1271).
      setPendingSign({ req, kind: req.method });
      setVisible(true);
      return;
    }
    if (req.method === "wallet_switchEthereumChain" || req.method === "wallet_addEthereumChain") {
      const chainId = ((req.params?.[0] as { chainId?: string } | undefined)?.chainId || "").toLowerCase();
      if (!chainId || !chainId.startsWith("0x")) {
        respondError(req.id, -32602, "missing or malformed chainId");
        return;
      }
      // Accept any chain. We emit events so the dApp's UI keeps in sync. If the
      // dApp later issues `eth_sendTransaction` on a chain we don't relay, that
      // call (and only that call) errors with a clear message.
      const previous = chainIdRef.current;
      chainIdRef.current = chainId;
      if (previous !== chainId) {
        window.parent.postMessage({ kind: "event", event: "chainChanged", payload: chainId }, "*");
        if (accountRef.current) {
          const addr = addressForChain(accountRef.current, parseInt(chainId, 16));
          window.parent.postMessage({ kind: "event", event: "accountsChanged", payload: [addr] }, "*");
        }
      }
      respondResult(req.id, null);
      return;
    }
    if (req.method === "wallet_getPermissions") {
      if (!accountRef.current) {
        respondResult(req.id, []);
        return;
      }
      respondResult(req.id, [
        buildEthAccountsPermission(addressForChain(accountRef.current, parseInt(chainIdRef.current, 16))),
      ]);
      return;
    }
    if (req.method === "wallet_requestPermissions") {
      const requested = (req.params?.[0] ?? {}) as Record<string, unknown>;
      if (!("eth_accounts" in requested)) {
        respondError(req.id, 4100, "only eth_accounts permission is supported");
        return;
      }
      if (accountRef.current) {
        respondResult(req.id, [
        buildEthAccountsPermission(addressForChain(accountRef.current, parseInt(chainIdRef.current, 16))),
      ]);
        return;
      }
      // Route permission requests through the same account-picker UX.
      setNeedsAccountFor(req);
      setVisible(true);
      return;
    }
    if (!PASSTHROUGH_BLOCKLIST.has(req.method)) {
      // Many dApps call read-only RPCs (balance, block, fee data) on the same
      // provider during connect. Forward to whichever chain is currently active.
      try {
        const client = clientForChain(parseInt(chainIdRef.current, 16));
        const result = await client.request({
          method: req.method as never,
          params: req.params as never,
        });
        respondResult(req.id, result);
        return;
      } catch (e) {
        respondError(req.id, -32603, (e as Error).message || "rpc passthrough failed");
        return;
      }
    }
    respondError(req.id, -32601, `method not supported: ${req.method}`);
  }

  /// Per-chain JAW address for an account.
  function addressForChain(acc: Account, chainId: number): `0x${string}` {
    return acc.addresses[chainId] ?? acc.addresses[SEPOLIA_CHAIN_ID];
  }

  async function handleResolve() {
    setError(null);
    if (!labelInput.match(/^[a-z0-9-]{1,32}$/)) {
      setError("Type a registered label.");
      return;
    }
    try {
      setBusy(true);
      const r = await resolveLabel(labelInput);
      // Pre-compute the factory-derived JAW address for Base Sepolia.
      // (Same address would also work on any other chain that has the canonical
      // JustanAccountFactory at 0x5803c076…, but for now we cap at Sepolia + Base.)
      const baseAddr = await predictFactoryJaw(r.qx, r.qy, 0n, BASE_SEPOLIA_CHAIN_ID);
      const acc: Account = {
        label: labelInput,
        fullName: r.fullName,
        addresses: {
          [SEPOLIA_CHAIN_ID]: r.account,
          [BASE_SEPOLIA_CHAIN_ID]: baseAddr,
        },
        qx: r.qx,
        qy: r.qy,
        credentialId: r.credentialId,
      };
      setAccount(acc);

      const currentChain = parseInt(chainIdRef.current, 16);
      const currentAddr = addressForChain(acc, currentChain);

      window.parent.postMessage(
        { kind: "event", event: "accountsChanged", payload: [currentAddr] },
        "*",
      );
      window.parent.postMessage(
        { kind: "event", event: "chainChanged", payload: chainIdRef.current },
        "*",
      );
      window.parent.postMessage(
        { kind: "event", event: "connect", payload: { chainId: chainIdRef.current } },
        "*",
      );
      // Resolve any pending eth_requestAccounts
      if (needsAccountFor) {
        if (needsAccountFor.method === "wallet_requestPermissions") {
          respondResult(needsAccountFor.id, [buildEthAccountsPermission(currentAddr)]);
        } else {
          respondResult(needsAccountFor.id, [currentAddr]);
        }
        const wasTx = needsAccountFor.method === "eth_sendTransaction";
        const queued = needsAccountFor;
        setNeedsAccountFor(null);
        if (!wasTx) {
          setVisible(false);
        } else {
          // re-queue the tx now that we have an account
          handleRpc(queued).catch(() => {});
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveTx() {
    if (!pendingTx || !account) return;
    const { req, to, value, data } = pendingTx;
    try {
      const chainId = parseInt(chainIdRef.current, 16);
      const client = clientForChain(chainId);

      setBusy(true);
      // Construct a viem SmartAccount tied to this label + chain. The adapter
      // pulls the passkey from ENS, picks the right per-chain JAW address, and
      // exposes encodeCalls / signUserOperation / signMessage / signTypedData.
      const smartAccount = await toENSignAccount({
        client,
        label: account.label,
        chainId,
      });

      // Pimlico's bundler does proper per-chain gas estimation
      // (eth_estimateUserOperationGas), which fixes "intrinsic gas too high".
      const bundler = createBundlerClient({
        client,
        transport: http(bundlerUrl(chainId)),
        account: smartAccount,
      });

      const opHash = await bundler.sendUserOperation({
        calls: [{ to, value, data }],
      });

      const receipt = await bundler.waitForUserOperationReceipt({ hash: opHash });

      if (!receipt.success) {
        respondError(
          req.id,
          -32603,
          `UserOp failed on-chain (tx ${receipt.receipt.transactionHash})`,
        );
      } else {
        respondResult(req.id, receipt.receipt.transactionHash);
      }
      setPendingTx(null);
      setVisible(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleRejectTx() {
    if (!pendingTx) return;
    respondError(pendingTx.req.id, 4001, "user rejected");
    setPendingTx(null);
    setVisible(false);
  }

  /// Sign with Face ID via ERC-7739. Returns a signature that the JAW's
  /// `isValidSignature` (ERC-1271) accepts.
  async function handleApproveSign() {
    if (!pendingSign || !account) return;
    const { req, kind } = pendingSign;
    try {
      setBusy(true);
      const chainId = parseInt(chainIdRef.current, 16);
      const client = clientForChain(chainId);
      const smartAccount = await toENSignAccount({
        client,
        label: account.label,
        chainId,
      });

      let signature: Hex;
      if (kind === "personal_sign") {
        // params for personal_sign per MetaMask order: [message, address]
        // (some dApps send [address, message] — handle both by pattern match)
        const a = req.params[0] as Hex | string;
        const b = req.params[1] as Hex | string;
        const isMessageA = typeof a === "string" && (a.startsWith("0x") || a.length > 42);
        const messageHex = (isMessageA ? a : b) as Hex;
        // Decode: hex (0x…) → raw bytes, otherwise UTF-8 string passes through.
        const message: { raw: Hex } | string =
          typeof messageHex === "string" && messageHex.startsWith("0x")
            ? { raw: messageHex as Hex }
            : (messageHex as string);
        signature = await smartAccount.signMessage({ message });
      } else {
        // eth_signTypedData_v4 — params: [address, typedDataJSON]
        const raw = req.params[1] as string | object;
        const typed =
          typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
        signature = await smartAccount.signTypedData(typed as never);
      }
      respondResult(req.id, signature);
      setPendingSign(null);
      setVisible(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleRejectSign() {
    if (!pendingSign) return;
    respondError(pendingSign.req.id, 4001, "user rejected");
    setPendingSign(null);
    setVisible(false);
  }

  // Decode calldata for pending tx — Sourcify/4byte lookup via whatsabi.
  const [decode, setDecode] = useState<DecodeResult | null>(null);
  const [decoding, setDecoding] = useState(false);
  useEffect(() => {
    if (!pendingTx) {
      setDecode(null);
      setDecoding(false);
      return;
    }
    let cancelled = false;
    setDecoding(true);
    setDecode(null);
    const chainId = parseInt(chainIdRef.current, 16);
    const client = clientForChain(chainId);
    decodeTx({
      client,
      to: pendingTx.to,
      value: pendingTx.value,
      data: pendingTx.data,
    })
      .then((res) => {
        if (!cancelled) setDecode(res);
      })
      .catch(() => {
        if (!cancelled) setDecode({ kind: "raw", raw: pendingTx.data });
      })
      .finally(() => {
        if (!cancelled) setDecoding(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingTx]);

  const activeChainId = parseInt(chainIdRef.current, 16);
  const chainName =
    activeChainId === BASE_SEPOLIA_CHAIN_ID ? "Base Sepolia" : "Sepolia";

  const decodedSignMessage = pendingSign
    ? decodePersonalSignParams(pendingSign.req.params)
    : "";
  const decodedTypedData = pendingSign && pendingSign.kind === "eth_signTypedData_v4"
    ? prettyTypedData(pendingSign.req.params[1])
    : "";

  return (
    <div className="jc">
      <header className="jc-bar">
        <div className="jc-mark">
          <span className="jc-mark-glyph" aria-hidden="true">JC</span>
          <span>ENSign</span>
        </div>
        <div className="jc-bar-right">
          {account && (
            <span className="jc-net-pill" title={`Connected to ${chainName}`}>
              <ChainIcon chainId={activeChainId} size={12} />
              <span>{chainName}</span>
            </span>
          )}
          <button
            className="jc-close"
            onClick={handleClose}
            disabled={busy}
            aria-label="Close"
            title="Close"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              padding: 0,
              border: "1px solid #ececea",
              background: "#ffffff",
              borderRadius: 8,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#000000"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: "block" }}
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </header>

      <main className="jc-stage">
        {needsAccountFor && !account && (
          <section className="jc-card" key="connect">
            <p className="jc-eyebrow">Connection request</p>
            <h2 className="jc-h2">Sign in with your name</h2>
            <p className="jc-p">
              Type the ENSign name you want to share with this site.
            </p>
            <label className="jc-input">
              <input
                placeholder="ricky"
                value={labelInput}
                onChange={(e) =>
                  setLabelInput(e.target.value.toLowerCase().trim())
                }
                autoFocus
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="jc-input-suffix">.{PARENT_NAME}</span>
            </label>
          </section>
        )}

        {account && !pendingTx && !pendingSign && !needsAccountFor && (
          <section className="jc-card" key="idle">
            <p className="jc-eyebrow">Connected</p>
            <div className="jc-identity">
              <span className="jc-avatar" aria-hidden="true">
                {account.label.slice(0, 1).toUpperCase()}
              </span>
              <div className="jc-identity-body">
                <span className="jc-identity-name">{account.fullName}</span>
                <span className="jc-identity-addr">
                  {shortAddr(addressForChain(account, activeChainId))}
                </span>
              </div>
              <div className="jc-identity-chain">
                <ChainIcon chainId={activeChainId} size={16} />
              </div>
            </div>
          </section>
        )}

        {pendingTx && account && (
          <section className="jc-card" key="tx">
            <p className="jc-eyebrow">Confirm transaction</p>

            {pendingTx.value > 0n && decode?.kind !== "send-eth" && (
              <div className="jc-amount">
                <span className="jc-amount-eyebrow">Value attached</span>
                <div className="jc-amount-row">
                  <span className="jc-amount-value">
                    {formatEthValue(pendingTx.value)}
                  </span>
                  <span className="jc-amount-sym">ETH</span>
                </div>
              </div>
            )}

            <dl className="jc-receipt">
              <div className="jc-receipt-row">
                <dt>From</dt>
                <dd>{account.fullName}</dd>
              </div>
              <div className="jc-receipt-row">
                <dt>To</dt>
                <dd className="mono">{shortAddr(pendingTx.to)}</dd>
              </div>
              <div className="jc-receipt-row">
                <dt>Network</dt>
                <dd className="jc-receipt-chain">
                  <ChainIcon chainId={activeChainId} />
                  <span>{chainName}</span>
                </dd>
              </div>
            </dl>

            <DecodedActionCard
              decoding={decoding}
              decode={decode}
              value={pendingTx.value}
              to={pendingTx.to}
            />
          </section>
        )}

        {pendingSign && account && (
          <section className="jc-card" key="sign">
            <p className="jc-eyebrow">
              {pendingSign.kind === "personal_sign"
                ? "Sign message"
                : "Sign typed data"}
            </p>
            <h2 className="jc-h2">Confirm with Face ID</h2>
            <p className="jc-p">
              Signing as <strong>{account.fullName}</strong>. Review the message
              before approving — your signature can grant access or move funds.
            </p>
            <pre className="jc-payload">
              {pendingSign.kind === "personal_sign"
                ? decodedSignMessage
                : decodedTypedData}
            </pre>
          </section>
        )}

      </main>

      {error && <div className="jc-error">{error}</div>}

      {needsAccountFor && !account && (
        <div className="jc-actions">
          <button
            className="jc-primary"
            onClick={handleResolve}
            disabled={busy || !labelInput}
          >
            {busy ? (
              <span className="jc-spin jc-spin--on-primary" aria-label="Working" />
            ) : (
              <>
                <span>Continue</span>
                <ArrowRight size={16} strokeWidth={2} />
              </>
            )}
          </button>
          <button className="jc-ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {pendingTx && account && (
        <div className="jc-actions jc-actions--row">
          <button
            className="jc-secondary"
            onClick={handleRejectTx}
            disabled={busy}
          >
            Reject
          </button>
          <button
            className="jc-primary"
            onClick={handleApproveTx}
            disabled={busy}
          >
            {busy ? (
              <span className="jc-spin jc-spin--on-primary" aria-label="Working" />
            ) : (
              <>
                <span>Approve</span>
                <ArrowRight size={16} strokeWidth={2} />
              </>
            )}
          </button>
        </div>
      )}

      {pendingSign && account && (
        <div className="jc-actions jc-actions--row">
          <button
            className="jc-secondary"
            onClick={handleRejectSign}
            disabled={busy}
          >
            Reject
          </button>
          <button
            className="jc-primary"
            onClick={handleApproveSign}
            disabled={busy}
          >
            {busy ? (
              <span className="jc-spin jc-spin--on-primary" aria-label="Working" />
            ) : (
              <>
                <span>Sign</span>
                <ArrowRight size={16} strokeWidth={2} />
              </>
            )}
          </button>
        </div>
      )}

      <div className="jc-foot">
        <span>Secured by</span>
        <strong>ENSign</strong>
      </div>
    </div>
  );
}

function DecodedActionCard({
  decoding,
  decode,
  value,
  to,
}: {
  decoding: boolean;
  decode: DecodeResult | null;
  value: bigint;
  to: `0x${string}`;
}) {
  if (decoding) {
    return (
      <div className="jc-decoded">
        <div className="jc-decoded-head">
          <span className="jc-decoded-iconbox" aria-hidden="true">
            <Code2 size={14} strokeWidth={1.75} />
          </span>
          <div>
            <div className="jc-decoded-title">Decoding…</div>
            <div className="jc-decoded-loading">
              <span className="jc-spin" />
              Looking up function on Sourcify
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!decode || decode.kind === "send-eth") {
    return (
      <div className="jc-decoded">
        <div className="jc-decoded-head">
          <span className="jc-decoded-iconbox" aria-hidden="true">
            <Send size={14} strokeWidth={1.75} />
          </span>
          <div>
            <div className="jc-decoded-title">
              Send {formatEthValue(value)} ETH
            </div>
            <div className="jc-decoded-sub">to {shortAddr(to)}</div>
          </div>
        </div>
      </div>
    );
  }

  if (decode.kind === "raw" || !decode.call) {
    return (
      <div className="jc-decoded">
        <div className="jc-decoded-head">
          <span className="jc-decoded-iconbox" aria-hidden="true">
            <Code2 size={14} strokeWidth={1.75} />
          </span>
          <div>
            <div className="jc-decoded-title">Contract interaction</div>
            <div className="jc-decoded-sub">
              {decode.raw.slice(0, 10)} · couldn't decode
            </div>
          </div>
        </div>
      </div>
    );
  }

  const call = decode.call;

  if (call.kind === "transfer") {
    const amt = formatTokenAmount(call.amountRaw, call.decimals, call.symbol);
    return (
      <div className="jc-decoded">
        <div className="jc-decoded-head">
          <span className="jc-decoded-iconbox" aria-hidden="true">
            <Send size={14} strokeWidth={1.75} />
          </span>
          <div>
            <div className="jc-decoded-title">Send {amt}</div>
            <div className="jc-decoded-sub">to {shortAddr(call.to)}</div>
          </div>
        </div>
      </div>
    );
  }

  if (call.kind === "approve") {
    const amt = formatTokenAmount(call.amountRaw, call.decimals, call.symbol);
    const isMax =
      call.amountRaw ===
      0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
    return (
      <div className="jc-decoded">
        <div className="jc-decoded-head">
          <span className="jc-decoded-iconbox" aria-hidden="true">
            <KeyRound size={14} strokeWidth={1.75} />
          </span>
          <div>
            <div className="jc-decoded-title">
              Approve {isMax ? "unlimited" : amt}
            </div>
            <div className="jc-decoded-sub">
              spender {shortAddr(call.spender)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (call.kind === "function") {
    return (
      <div className="jc-decoded">
        <div className="jc-decoded-head">
          <span className="jc-decoded-iconbox" aria-hidden="true">
            <Code2 size={14} strokeWidth={1.75} />
          </span>
          <div>
            <div className="jc-decoded-title">{call.name}</div>
            <div className="jc-decoded-sub">{call.signature}</div>
          </div>
        </div>
        {call.args.length > 0 && (
          <div className="jc-args">
            {call.args.map((a, i) => (
              <div className="jc-arg" key={i}>
                <div className="jc-arg-head">
                  <span className="jc-arg-name">{a.name}</span>
                  <span className="jc-arg-type">{a.type}</span>
                </div>
                <span className="jc-arg-value">{shortenArg(a.value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // unknown
  return (
    <div className="jc-decoded">
      <div className="jc-decoded-head">
        <span className="jc-decoded-iconbox" aria-hidden="true">
          <Code2 size={14} strokeWidth={1.75} />
        </span>
        <div>
          <div className="jc-decoded-title">Unknown function</div>
          <div className="jc-decoded-sub">selector {call.selector}</div>
        </div>
      </div>
    </div>
  );
}

function shortenArg(v: string): string {
  if (v.startsWith("0x") && v.length > 22) return `${v.slice(0, 12)}…${v.slice(-6)}`;
  if (v.length > 56) return `${v.slice(0, 30)}…${v.slice(-12)}`;
  return v;
}


function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/// Inline SVG glyphs for Sepolia (Ethereum diamond) and Base (B mark).
function ChainIcon({ chainId, size = 14 }: { chainId: number; size?: number }) {
  if (chainId === 84532) {
    // Base — solid blue circle with stylized B mark.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
        <circle cx="12" cy="12" r="11" fill="#0052ff" />
        <path
          d="M11.5 5.5C7.91 5.5 5 8.41 5 12s2.91 6.5 6.5 6.5h7v-2.6h-7a3.9 3.9 0 0 1 0-7.8h7V5.5h-7Z"
          fill="#ffffff"
        />
      </svg>
    );
  }
  // Sepolia / default Ethereum mark.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="11" fill="#627eea" />
      <path d="M12 3.5 6.5 12.4l5.5 3.2V3.5Z" fill="#ffffff" fillOpacity="0.6" />
      <path d="M12 3.5v12.1l5.5-3.2L12 3.5Z" fill="#ffffff" />
      <path d="m12 16.7-5.5-3.2L12 21.5l5.5-8-5.5 3.2Z" fill="#ffffff" fillOpacity="0.6" />
      <path d="M12 21.5v-4.8L6.5 13.5 12 21.5Z" fill="#ffffff" fillOpacity="0.45" />
      <path d="m6.5 12.4 5.5 3.2v-5.4L6.5 12.4Z" fill="#ffffff" fillOpacity="0.85" />
      <path d="M12 10.2v5.4l5.5-3.2L12 10.2Z" fill="#ffffff" fillOpacity="0.7" />
    </svg>
  );
}

function formatEthValue(wei: bigint): string {
  if (wei === 0n) return "0";
  const eth = Number(formatEther(wei));
  if (Number.isNaN(eth)) return wei.toString();
  if (eth < 0.0001) return eth.toExponential(2);
  if (eth < 1) return eth.toFixed(4).replace(/\.?0+$/, "");
  return eth.toFixed(4).replace(/\.?0+$/, "");
}

function decodePersonalSignParams(params: unknown[]): string {
  const a = params[0];
  const b = params[1];
  const isMessageA = typeof a === "string" && (a.startsWith("0x") || a.length > 42);
  const m = (isMessageA ? a : b) as string;
  if (typeof m === "string" && m.startsWith("0x")) {
    try {
      return new TextDecoder().decode(
        Uint8Array.from(
          (m.slice(2).match(/.{1,2}/g) ?? []).map((h) => parseInt(h, 16)),
        ),
      );
    } catch {
      return m;
    }
  }
  return typeof m === "string" ? m : JSON.stringify(m);
}

function prettyTypedData(raw: unknown): string {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(raw);
  }
}
