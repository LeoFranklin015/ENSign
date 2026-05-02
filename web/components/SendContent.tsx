"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import "../app/app.css";
import {
  PARENT_NAME,
  publicClient,
  resolveLabel,
  sendUserOp,
} from "@/lib/ensign";
import { getSession } from "@/lib/session";
import { Nav } from "@/components/Nav";
import { MultiStepLoader, type Step } from "@/components/MultiStepLoader";

const SEND_STEPS: Step[] = [
  {
    id: "resolve",
    label: "resolve from ens",
    description: "registry → resolver → addr(node) · pulls latest credential",
  },
  {
    id: "send",
    label: "sponsor + sign + send",
    description: "pimlico paymaster sponsors gas · passkey signs · bundler broadcasts",
  },
];

const RELAYER = "0xE08224B2CfaF4f27E2DC7cB3f6B99AcC68Cf06c0";

type SendState =
  | { phase: "idle" }
  | { phase: "active"; stepId: string }
  | { phase: "error"; stepId: string; message: string }
  | {
      phase: "done";
      result: { tx: string; success: boolean; gasUsed: string };
    };

export default function SendContent() {
  const router = useRouter();
  const [label, setLabel] = useState<string>("");
  const [target, setTarget] = useState(RELAYER);
  const [valueWei, setValueWei] = useState("1");
  const [resolved, setResolved] = useState<{
    account: `0x${string}`;
    balance: bigint;
  } | null>(null);
  const [send, setSend] = useState<SendState>({ phase: "idle" });

  // Pull session label as default "from".
  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace("/");
      return;
    }
    setLabel(s.label);
  }, [router]);

  // Auto-resolve.
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    if (!label.match(/^[a-z0-9-]{1,32}$/)) return;
    (async () => {
      try {
        const r = await resolveLabel(label);
        const b = await publicClient.getBalance({ address: r.account });
        if (cancelled) return;
        setResolved({ account: r.account, balance: b });
      } catch {
        // not registered
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [label]);

  const isBusy = send.phase === "active";

  async function onSend() {
    if (!resolved) {
      setSend({ phase: "error", stepId: "resolve", message: "type a registered name first." });
      return;
    }
    if (!target.match(/^0x[a-fA-F0-9]{40}$/)) {
      setSend({ phase: "error", stepId: "resolve", message: "target address looks malformed." });
      return;
    }
    let value: bigint;
    try {
      value = BigInt(valueWei);
    } catch {
      setSend({ phase: "error", stepId: "resolve", message: "value must be an integer (wei)." });
      return;
    }

    try {
      setSend({ phase: "active", stepId: "resolve" });
      const fresh = await resolveLabel(label);

      setSend({ phase: "active", stepId: "send" });
      const r = await sendUserOp({
        account: fresh.account,
        credentialId: fresh.credentialId,
        target: target as `0x${string}`,
        value,
      });
      setSend({ phase: "done", result: r });
    } catch (e) {
      const stepId = send.phase === "active" ? send.stepId : "resolve";
      setSend({ phase: "error", stepId, message: (e as Error).message });
    }
  }

  function reset() {
    setSend({ phase: "idle" });
  }

  return (
    <div className="app-shell">
      <Nav />

      <main className="main">
        <section className="hero compact">
          <p className="kicker">send</p>
          <h1 className="hero-title-sm">
            sign by <em>name</em>.
          </h1>
          <p className="hero-sub">
            We resolve the name on-chain, build the UserOp, your passkey signs, and a public
            bundler broadcasts. <strong>No login. No session.</strong>
          </p>
        </section>

        {send.phase === "idle" || send.phase === "error" ? (
          <div className="form-card">
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

            <button className="action" onClick={onSend} disabled={!resolved}>
              <span>sign and broadcast</span>
              <span className="action-arrow">→</span>
            </button>

            {send.phase === "error" && (
              <div className="err">{send.message}</div>
            )}
          </div>
        ) : (
          <div className="form-card">
            <p className="signup-prompt">
              broadcasting from <em>{label}.{PARENT_NAME}</em>
            </p>
            <MultiStepLoader
              steps={SEND_STEPS}
              currentId={send.phase === "active" ? send.stepId : null}
              done={send.phase === "done"}
              error={null}
            />

            {send.phase === "done" && (
              <>
                <div className={`receipt`}>
                  <div className="receipt-top">
                    <p className="receipt-name">
                      <b>{send.result.success ? "broadcast" : "reverted"}</b>{" "}
                      <span>by name</span>
                    </p>
                    <span
                      className={`receipt-stamp${send.result.success ? "" : " fail"}`}
                    >
                      {send.result.success ? "ok" : "failed"}
                    </span>
                  </div>
                  <dl className="receipt-grid">
                    <dt>tx</dt>
                    <dd>
                      <a
                        href={`https://sepolia.etherscan.io/tx/${send.result.tx}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {send.result.tx}
                      </a>
                    </dd>
                    <dt>gas used</dt>
                    <dd>{Number(send.result.gasUsed).toLocaleString()}</dd>
                  </dl>
                </div>
                <button className="action" onClick={reset} style={{ marginTop: 24 }}>
                  <span>send another</span>
                  <span className="action-arrow">↺</span>
                </button>
              </>
            )}
          </div>
        )}
      </main>

      <footer className="foot">
        <span className="brand-name">
          EN<em style={{ color: "var(--acc)", fontStyle: "normal" }}>S</em>ign
        </span>
        <span>signing as <span style={{ color: "var(--text-soft)" }}>{label}.{PARENT_NAME}</span></span>
      </footer>
    </div>
  );
}

function formatWei(wei: bigint): string {
  if (wei === 0n) return "0 wei";
  if (wei < 1_000_000n) return `${wei.toString()} wei`;
  if (wei < 10n ** 18n) return `${(Number(wei) / 1e9).toFixed(4)} gwei`;
  return `${(Number(wei) / 1e18).toFixed(6)} ETH`;
}
