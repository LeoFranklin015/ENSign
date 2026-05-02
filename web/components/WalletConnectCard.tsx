"use client";

import { useEffect, useRef, useState } from "react";
import {
  approveProposal,
  disconnectSession,
  getWalletKit,
  handleRequest,
  listActiveSessions,
  pair,
  rejectProposal,
  respondError,
  respondSuccess,
  resolveLabel,
} from "@/lib/walletconnect";
import { PARENT_NAME } from "@/lib/ensign";

type Pending =
  | { kind: "proposal"; id: number; meta: { name: string; url: string; icons: string[] } }
  | {
      kind: "request";
      id: number;
      topic: string;
      method: string;
      params: unknown[];
      meta: { name: string; url: string; icons: string[] };
    };

type Step = "idle" | "resolving" | "signing" | "relaying" | "done";

export function WalletConnectCard() {
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [credentialId, setCredentialId] = useState<string>("");
  const [uri, setUri] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [sessions, setSessions] = useState<
    Array<{ topic: string; peer: { name: string; url: string } }>
  >([]);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const initRef = useRef(false);

  // Boot WalletKit once and wire the listeners.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    let unmounted = false;

    (async () => {
      try {
        const wk = await getWalletKit();
        if (unmounted) return;
        push("walletkit ready");
        refreshSessions();

        wk.on("session_proposal", (ev) => {
          push(`session_proposal from ${ev.params.proposer.metadata.name}`);
          setPending((p) => [
            ...p,
            {
              kind: "proposal",
              id: ev.id,
              meta: ev.params.proposer.metadata,
            },
          ]);
        });

        wk.on("session_request", async (ev) => {
          const session = wk.getActiveSessions()[ev.topic];
          push(`session_request: ${ev.params.request.method}`);
          setPending((p) => [
            ...p,
            {
              kind: "request",
              id: ev.id,
              topic: ev.topic,
              method: ev.params.request.method,
              params: ev.params.request.params as unknown[],
              meta: session?.peer.metadata ?? { name: "?", url: "", icons: [] },
            },
          ]);
        });

        wk.on("session_delete", () => {
          push("session deleted");
          refreshSessions();
        });
      } catch (e) {
        setError((e as Error).message);
      }
    })();

    return () => {
      unmounted = true;
    };
  }, []);

  function push(msg: string) {
    setLog((l) => [...l.slice(-20), `${new Date().toLocaleTimeString()} ${msg}`]);
  }

  async function refreshSessions() {
    const list = await listActiveSessions();
    setSessions(
      list.map((s) => ({
        topic: s.topic,
        peer: {
          name: s.peer.metadata.name,
          url: s.peer.metadata.url,
        },
      })),
    );
  }

  async function handleResolve() {
    setError(null);
    setAccount(null);
    setCredentialId("");
    if (!label.match(/^[a-z0-9-]{1,32}$/)) {
      setError("Type a registered label first.");
      return;
    }
    try {
      setStep("resolving");
      const r = await resolveLabel(label);
      setAccount(r.account);
      setCredentialId(r.credentialId);
      push(`resolved ${r.fullName} → ${r.account.slice(0, 10)}…`);
      setStep("idle");
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  async function handlePair() {
    setError(null);
    if (!uri.startsWith("wc:")) {
      setError("Paste a valid wc: URI from the dApp's QR.");
      return;
    }
    if (!account) {
      setError("Resolve a label first so the dApp gets a connected account.");
      return;
    }
    try {
      await pair(uri);
      setUri("");
      push("paired");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleApprove(p: Extract<Pending, { kind: "proposal" }>) {
    if (!account) {
      setError("Resolve a label first.");
      return;
    }
    try {
      await approveProposal(p.id, account);
      setPending((all) => all.filter((x) => x !== p));
      await refreshSessions();
      push(`approved session for ${p.meta.name}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleReject(p: Extract<Pending, { kind: "proposal" }>) {
    await rejectProposal(p.id);
    setPending((all) => all.filter((x) => x !== p));
    push(`rejected session for ${p.meta.name}`);
  }

  async function handleSign(req: Extract<Pending, { kind: "request" }>) {
    if (!account || !credentialId) {
      setError("Lost wallet context — re-resolve label.");
      return;
    }
    try {
      setStep("signing");
      const r = await handleRequest(
        { topic: req.topic, params: { request: { method: req.method, params: req.params } }, id: req.id },
        { label, account, credentialId },
      );
      if (r.error) {
        await respondError(req.topic, req.id, r.error);
        push(`responded error: ${r.error.message}`);
      } else {
        await respondSuccess(req.topic, req.id, r.result);
        push(`responded result: ${String(r.result).slice(0, 18)}…`);
      }
      setPending((all) => all.filter((x) => x !== req));
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  async function handleRejectRequest(req: Extract<Pending, { kind: "request" }>) {
    await respondError(req.topic, req.id, { code: 5000, message: "user rejected" });
    setPending((all) => all.filter((x) => x !== req));
    push("rejected request");
  }

  async function handleDisconnect(topic: string) {
    await disconnectSession(topic);
    await refreshSessions();
  }

  return (
    <section className="card">
      <h2>Connect to any dApp via WalletConnect</h2>
      <p className="muted">
        Open a dApp (Uniswap, OpenSea, anything that supports WalletConnect), copy the WC URI from
        its "Connect Wallet" QR, and paste it below. Sessions are bound to a ENSign name —
        every signing request triggers Face ID for that name.
      </p>

      <label className="field">
        <span>From name</span>
        <div className="row">
          <input
            placeholder="ricky"
            value={label}
            onChange={(e) => setLabel(e.target.value.toLowerCase().trim())}
          />
          <span className="suffix">.{PARENT_NAME}</span>
          <button onClick={handleResolve} disabled={step === "resolving"}>
            {step === "resolving" ? "…" : "Resolve"}
          </button>
        </div>
      </label>

      {account && (
        <div className="muted small">
          → <code>{account}</code>{" "}
          {credentialId
            ? "(passkey ready — chooser will be skipped)"
            : "(no credentialId on chain — OS chooser will be used)"}
        </div>
      )}

      <label className="field">
        <span>WalletConnect URI</span>
        <input
          placeholder="wc:..."
          value={uri}
          onChange={(e) => setUri(e.target.value.trim())}
        />
      </label>
      <button onClick={handlePair} disabled={!uri || !account}>
        Pair
      </button>

      {pending.map((p) =>
        p.kind === "proposal" ? (
          <div key={p.id} className="proposal">
            <strong>Connection request</strong>
            <div className="muted small">
              {p.meta.name} ({p.meta.url})
            </div>
            <div className="actions">
              <button onClick={() => handleApprove(p)}>Approve as {label}</button>
              <button className="ghost" onClick={() => handleReject(p)}>
                Reject
              </button>
            </div>
          </div>
        ) : (
          <div key={p.id} className="proposal">
            <strong>{p.method}</strong>
            <div className="muted small">{p.meta.name}</div>
            <pre className="payload">{JSON.stringify(p.params, null, 2)}</pre>
            <div className="actions">
              <button onClick={() => handleSign(p)} disabled={step === "signing"}>
                {step === "signing" ? "Awaiting Face ID…" : "Sign with passkey"}
              </button>
              <button className="ghost" onClick={() => handleRejectRequest(p)}>
                Reject
              </button>
            </div>
          </div>
        ),
      )}

      {sessions.length > 0 && (
        <div className="sessions">
          <strong>Active sessions</strong>
          {sessions.map((s) => (
            <div key={s.topic} className="session-row">
              <span>
                {s.peer.name}{" "}
                <span className="muted small">({s.peer.url})</span>
              </span>
              <button className="ghost" onClick={() => handleDisconnect(s.topic)}>
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      {log.length > 0 && (
        <details className="log">
          <summary className="muted small">Activity log</summary>
          <pre>{log.join("\n")}</pre>
        </details>
      )}

      {error && <div className="err">{error}</div>}
    </section>
  );
}