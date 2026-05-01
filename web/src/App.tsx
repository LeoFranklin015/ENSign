import { useEffect, useState } from "react";
import "./App.css";
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
} from "./lib/ensign";
import { WalletConnectCard } from "./components/WalletConnectCard";
import { BookmarkletCard } from "./components/BookmarkletCard";

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>ENSign</h1>
        <p className="tag">Sign with ENS. Subname is the wallet.</p>
        <p className="muted small">
          Registry:{" "}
          <a
            href={`https://sepolia.etherscan.io/address/${REGISTRY}`}
            target="_blank"
            rel="noreferrer"
            className="link"
          >
            {REGISTRY.slice(0, 10)}…
          </a>{" "}
          · parent: <code>{PARENT_NAME}</code>
        </p>
      </header>

      <main>
        <RegisterCard />
        <SendCard />
        <WalletConnectCard />
        <BookmarkletCard />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register card — claim a fresh subname with a new passkey
// ---------------------------------------------------------------------------

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
      setError("Label must be 1-32 chars: lowercase letters, digits, hyphens.");
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

  return (
    <section className="card">
      <h2>Register a name</h2>
      <p className="muted">
        Create a fresh passkey (Face ID / Touch ID) and atomically mint{" "}
        <code>{`<label>.${PARENT_NAME}`}</code> as a smart account owned by that passkey. Nothing
        is saved client-side — the public key lives on the JAW account, the credential lives in
        your authenticator.
      </p>
      <div className="row">
        <input
          placeholder="alice"
          value={label}
          onChange={(e) => setLabel(e.target.value.toLowerCase().trim())}
          disabled={isBusy}
          autoFocus
        />
        <span className="suffix">.{PARENT_NAME}</span>
      </div>
      <button onClick={handleCreate} disabled={isBusy || !label}>
        {step === "creating"
          ? "Awaiting Face ID…"
          : step === "registering"
            ? "Registering on Sepolia…"
            : "Create passkey + claim"}
      </button>

      {error && <div className="err">{error}</div>}
      {result && (
        <div className="ok">
          <strong>Registered {result.fullName}</strong>
          <dl className="kv">
            <dt>JAW account</dt>
            <dd>
              <a
                href={`https://sepolia.etherscan.io/address/${result.account}`}
                target="_blank"
                rel="noreferrer"
              >
                {result.account}
              </a>
            </dd>
            <dt>Register tx</dt>
            <dd>
              <a
                href={`https://sepolia.etherscan.io/tx/${result.registerTx}`}
                target="_blank"
                rel="noreferrer"
              >
                {result.registerTx.slice(0, 18)}…
              </a>
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Send card — name-driven transaction signing
// ---------------------------------------------------------------------------

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

  // Auto-resolve when the user types a valid label
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    if (!label.match(/^[a-z0-9-]{1,32}$/)) return;
    (async () => {
      try {
        const r = await resolveLabel(label);
        const balance = await publicClient.getBalance({ address: r.account });
        if (cancelled) return;
        setResolved({ fullName: r.fullName, account: r.account, balance: balance.toString() });
      } catch {
        // silently ignore — name not registered yet
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
      setError("Type a registered label first.");
      return;
    }
    if (!target.match(/^0x[a-fA-F0-9]{40}$/)) {
      setError("Target address looks malformed.");
      return;
    }
    let value: bigint;
    try {
      value = BigInt(valueWei);
    } catch {
      setError("Value must be an integer (in wei).");
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

  return (
    <section className="card">
      <h2>Send a transaction</h2>
      <p className="muted">
        Type a registered name. We resolve it from ENS, build the UserOp, and your browser
        prompts the matching passkey via Face ID / Touch ID. No login, no session — pick the name
        each time.
      </p>

      <label className="field">
        <span>From name</span>
        <div className="row">
          <input
            placeholder="alice"
            value={label}
            onChange={(e) => setLabel(e.target.value.toLowerCase().trim())}
            disabled={isBusy}
          />
          <span className="suffix">.{PARENT_NAME}</span>
        </div>
      </label>

      {resolved && (
        <dl className="kv">
          <dt>resolves to</dt>
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
          <dd>{resolved.balance} wei</dd>
        </dl>
      )}

      <label className="field">
        <span>Send to</span>
        <input
          placeholder="0x…"
          value={target}
          onChange={(e) => setTarget(e.target.value.trim())}
          disabled={isBusy}
        />
      </label>

      <label className="field">
        <span>Amount (wei)</span>
        <input
          type="text"
          inputMode="numeric"
          value={valueWei}
          onChange={(e) => setValueWei(e.target.value.trim())}
          disabled={isBusy}
        />
      </label>

      <button onClick={handleSend} disabled={isBusy || !resolved}>
        {step === "resolving"
          ? "Resolving…"
          : step === "signing"
            ? "Pick passkey, then Face ID…"
            : step === "relaying"
              ? "Relaying through EntryPoint…"
              : "Sign with passkey + send"}
      </button>

      {error && <div className="err">{error}</div>}
      {result && (
        <div className={result.success ? "ok" : "err"}>
          <strong>{result.success ? "UserOp succeeded" : "UserOp failed"}</strong>
          <div>
            tx:{" "}
            <a
              href={`https://sepolia.etherscan.io/tx/${result.tx}`}
              target="_blank"
              rel="noreferrer"
            >
              {result.tx.slice(0, 18)}…
            </a>
          </div>
          <div>gas used: {result.gasUsed}</div>
        </div>
      )}
    </section>
  );
}
