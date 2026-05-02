"use client";

import { useEffect, useState } from "react";
import "../app/app.css";
import {
  PARENT_NAME,
  REGISTRY,
  buildExecuteUserOp,
  createPasskeyForLabel,
  getUserOpHash,
  publicClient,
  registerName,
  relayUserOp,
  resolveLabel,
  signUserOpHashForName,
} from "@/lib/ensign";
import { BookmarkletCard } from "@/components/BookmarkletCard";

export default function AppContent() {
  return (
    <div className="app-shell">
      <header className="bar">
        <span className="brand">
          <span className="brand-glyph" aria-hidden="true" />
          <span className="brand-name">
            EN<em>S</em>ign
          </span>
        </span>
        <div className="bar-right">
          <span className="tag">
            <span className="tag-pulse" aria-hidden="true" />
            <span>sepolia · v2 staging</span>
          </span>
          <a
            href={`https://explorer.ens.dev/${PARENT_NAME}/subnames`}
            target="_blank"
            rel="noreferrer"
            title="parent name"
          >
            {PARENT_NAME}
          </a>
          <a
            href={`https://sepolia.etherscan.io/address/${REGISTRY}`}
            target="_blank"
            rel="noreferrer"
            title="ENSign registry"
          >
            {REGISTRY.slice(0, 6)}…{REGISTRY.slice(-4)}
          </a>
        </div>
      </header>

      <main className="main">
        <section className="hero">
          <p className="kicker">sign with name</p>
          <h1 className="hero-title">
            your name<br />
            is the <em>wallet</em>.
          </h1>
          <p className="hero-sub">
            Type a name. Touch your face. The ENS subname <strong>is</strong> the smart account —
            passkey-controlled, self-custodial, no seed phrase, no extension, nothing to install.
          </p>
        </section>

        <section className="section">
          <header className="section-header">
            <h2 className="section-title">claim</h2>
            <span className="section-meta">01 / register a name</span>
          </header>
          <RegisterCard />
        </section>

        <section className="section">
          <header className="section-header">
            <h2 className="section-title">sign</h2>
            <span className="section-meta">02 / send by name</span>
          </header>
          <SendCard />
        </section>

        <section className="section">
          <header className="section-header">
            <h2 className="section-title">embed</h2>
            <span className="section-meta">03 / wallet on any dApp</span>
          </header>
          <p className="lead">
            Drop the bookmarklet into your bar — <em>any dApp</em> sees ENSign as a wallet.
            No extension to install, nothing for the dApp to integrate.
          </p>
          <BookmarkletCard />
        </section>
      </main>

      <footer className="foot">
        <span className="brand-name">
          EN<em style={{ color: "var(--acc)", fontStyle: "normal" }}>S</em>ign
        </span>
        <span>sepolia · v2 staging · live</span>
        <a
          href="https://github.com/LeoFranklin015/ENSign"
          target="_blank"
          rel="noreferrer"
        >
          github
        </a>
      </footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Register
// ───────────────────────────────────────────────────────────────────────

type RegisterStep = "idle" | "creating" | "registering" | "done";

function RegisterCard() {
  const [label, setLabel] = useState("");
  const [step, setStep] = useState<RegisterStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    fullName: string;
    account: `0x${string}`;
    registerTx: string;
  } | null>(null);

  const isBusy = step === "creating" || step === "registering";

  async function handleCreate() {
    setError(null);
    setResult(null);
    if (!label.match(/^[a-z0-9-]{1,32}$/)) {
      setError("Label must be 1–32 chars: lowercase letters, digits, hyphens.");
      return;
    }
    try {
      setStep("creating");
      const { qx, qy, credentialId } = await createPasskeyForLabel(label);
      setStep("registering");
      const out = await registerName(label, qx, qy, credentialId);
      setResult({
        fullName: `${label}.${PARENT_NAME}`,
        account: out.account,
        registerTx: out.registerTx,
      });
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  const stepCopy =
    step === "creating"
      ? "awaiting face id"
      : step === "registering"
        ? "registering on sepolia"
        : "sign with face id";

  return (
    <>
      <p className="lead">
        Create a passkey, atomically bind it to <em>{`<your-name>.${PARENT_NAME}`}</em>.
        The subname <em>is</em> the wallet — `addr(node)` returns the smart account address.
      </p>

      <div className="amount-input">
        <input
          placeholder="alice"
          value={label}
          onChange={(e) => setLabel(e.target.value.toLowerCase().trim())}
          disabled={isBusy}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <span className="suffix">.{PARENT_NAME}</span>
      </div>

      <button
        className={`action${isBusy ? " busy" : ""}`}
        onClick={handleCreate}
        disabled={isBusy || !label}
      >
        <span>{stepCopy}</span>
        <span className="action-arrow">{isBusy ? "···" : "→"}</span>
      </button>

      {isBusy && (
        <div className="status">
          <span className="status-dot" aria-hidden="true" />
          <span>
            {step === "creating"
              ? "credential ceremony in browser"
              : "broadcasting to ensign registry"}
          </span>
        </div>
      )}

      {error && <div className="err">{error}</div>}

      {result && (
        <div className="receipt">
          <div className="receipt-top">
            <p className="receipt-name">
              <b>{result.fullName.split(".")[0]}</b>
              <span>.{PARENT_NAME}</span>
            </p>
            <span className="receipt-stamp">sealed</span>
          </div>
          <dl className="receipt-grid">
            <dt>account</dt>
            <dd>
              <a
                href={`https://sepolia.etherscan.io/address/${result.account}`}
                target="_blank"
                rel="noreferrer"
              >
                {result.account}
              </a>
            </dd>
            <dt>tx</dt>
            <dd>
              <a
                href={`https://sepolia.etherscan.io/tx/${result.registerTx}`}
                target="_blank"
                rel="noreferrer"
              >
                {result.registerTx}
              </a>
            </dd>
          </dl>
        </div>
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Send
// ───────────────────────────────────────────────────────────────────────

const RELAYER = "0xE08224B2CfaF4f27E2DC7cB3f6B99AcC68Cf06c0";

type SendStep = "idle" | "resolving" | "signing" | "relaying" | "done";

function SendCard() {
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState(RELAYER);
  const [valueWei, setValueWei] = useState("1");
  const [step, setStep] = useState<SendStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{
    fullName: string;
    account: `0x${string}`;
    balance: string;
  } | null>(null);
  const [result, setResult] = useState<{
    tx: string;
    success: boolean;
    gasUsed: string;
  } | null>(null);

  const isBusy = step === "resolving" || step === "signing" || step === "relaying";

  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    if (!label.match(/^[a-z0-9-]{1,32}$/)) return;
    (async () => {
      try {
        const r = await resolveLabel(label);
        const balance = await publicClient.getBalance({ address: r.account });
        if (cancelled) return;
        setResolved({
          fullName: r.fullName,
          account: r.account,
          balance: balance.toString(),
        });
      } catch {
        // not registered yet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [label]);

  async function handleSend() {
    setError(null);
    setResult(null);
    if (!resolved) {
      setError("type a registered name first.");
      return;
    }
    if (!target.match(/^0x[a-fA-F0-9]{40}$/)) {
      setError("target address looks malformed.");
      return;
    }
    let value: bigint;
    try {
      value = BigInt(valueWei);
    } catch {
      setError("value must be an integer in wei.");
      return;
    }
    try {
      setStep("resolving");
      const fresh = await resolveLabel(label);

      setStep("signing");
      const userOp = await buildExecuteUserOp({
        account: fresh.account,
        target: target as `0x${string}`,
        value,
      });
      const hash = await getUserOpHash(userOp);
      const sig = await signUserOpHashForName(hash, fresh.credentialId);
      userOp.signature = sig;

      setStep("relaying");
      const r = await relayUserOp(userOp);
      setResult(r);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  const stepCopy =
    step === "resolving"
      ? "walking ens"
      : step === "signing"
        ? "awaiting face id"
        : step === "relaying"
          ? "broadcasting"
          : "sign and broadcast";

  return (
    <>
      <p className="lead">
        Type a registered name. We resolve on-chain, build the UserOp, and your browser asks the
        right passkey by name. <em>No login. No session.</em>
      </p>

      <div className="amount-input">
        <input
          placeholder="alice"
          value={label}
          onChange={(e) => setLabel(e.target.value.toLowerCase().trim())}
          disabled={isBusy}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="suffix">.{PARENT_NAME}</span>
      </div>

      {resolved && (
        <dl className="resolve">
          <dt>resolves</dt>
          <dd>
            <a
              href={`https://sepolia.etherscan.io/address/${resolved.account}`}
              target="_blank"
              rel="noreferrer"
            >
              {resolved.account}
            </a>
          </dd>
          <dt>balance</dt>
          <dd>{formatWei(resolved.balance)}</dd>
        </dl>
      )}

      <div className="field">
        <span className="field-label">to</span>
        <input
          placeholder="0x…"
          value={target}
          onChange={(e) => setTarget(e.target.value.trim())}
          disabled={isBusy}
        />
      </div>
      <div className="field">
        <span className="field-label">value (wei)</span>
        <input
          type="text"
          inputMode="numeric"
          value={valueWei}
          onChange={(e) => setValueWei(e.target.value.trim())}
          disabled={isBusy}
        />
      </div>

      <button
        className={`action${isBusy ? " busy" : ""}`}
        onClick={handleSend}
        disabled={isBusy || !resolved}
        style={{ marginTop: 24 }}
      >
        <span>{stepCopy}</span>
        <span className="action-arrow">{isBusy ? "···" : "→"}</span>
      </button>

      {isBusy && (
        <div className="status">
          <span className="status-dot" aria-hidden="true" />
          <span>
            {step === "resolving"
              ? "registry → resolver → addr"
              : step === "signing"
                ? "browser passkey ceremony"
                : "EntryPoint.handleOps"}
          </span>
        </div>
      )}

      {error && <div className="err">{error}</div>}

      {result && (
        <div className="receipt">
          <div className="receipt-top">
            <p className="receipt-name">
              <b>{result.success ? "broadcast" : "reverted"}</b>{" "}
              <span>by name</span>
            </p>
            <span className={`receipt-stamp${result.success ? "" : " fail"}`}>
              {result.success ? "ok" : "failed"}
            </span>
          </div>
          <dl className="receipt-grid">
            <dt>tx</dt>
            <dd>
              <a
                href={`https://sepolia.etherscan.io/tx/${result.tx}`}
                target="_blank"
                rel="noreferrer"
              >
                {result.tx}
              </a>
            </dd>
            <dt>gas used</dt>
            <dd>{Number(result.gasUsed).toLocaleString()}</dd>
          </dl>
        </div>
      )}
    </>
  );
}

function formatWei(wei: string): string {
  try {
    const v = BigInt(wei);
    if (v === 0n) return "0 wei";
    if (v < 1_000_000n) return `${v.toString()} wei`;
    if (v < 10n ** 18n) return `${(Number(v) / 1e9).toFixed(4)} gwei`;
    return `${(Number(v) / 1e18).toFixed(6)} ETH`;
  } catch {
    return wei;
  }
}
