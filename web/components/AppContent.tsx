"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import "../app/app.css";
import {
  PARENT_NAME,
  createPasskeyForLabel,
  registerName,
} from "@/lib/ensign";
import { getSession, saveSession } from "@/lib/session";
import { Nav } from "@/components/Nav";
import { MultiStepLoader, type Step } from "@/components/MultiStepLoader";

const SIGNUP_STEPS: Step[] = [
  {
    id: "passkey",
    label: "create passkey",
    description: "browser asks for your passkey · biometric or hardware key",
  },
  {
    id: "register",
    label: "claim subname",
    description: "atomic mint inside the canonical UserRegistry on sepolia",
  },
  {
    id: "settle",
    label: "settle on chain",
    description: "wait for receipt · prepare smart-account dashboard",
  },
];

type SignupState =
  | { phase: "idle" }
  | { phase: "active"; stepId: string }
  | { phase: "error"; stepId: string; message: string }
  | { phase: "done" };

export default function AppContent() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [signup, setSignup] = useState<SignupState>({ phase: "idle" });
  const [hasSession, setHasSession] = useState(false);

  // If already logged in, gently surface a "go to dashboard" hint.
  useEffect(() => {
    setHasSession(!!getSession());
  }, []);

  const isBusy = signup.phase === "active" || signup.phase === "done";

  async function onSign() {
    if (!label.match(/^[a-z0-9-]{1,32}$/)) {
      setSignup({
        phase: "error",
        stepId: "passkey",
        message: "label must be 1–32 chars: lowercase letters, digits, hyphens.",
      });
      return;
    }
    try {
      setSignup({ phase: "active", stepId: "passkey" });
      const { qx, qy, credentialId } = await createPasskeyForLabel(label);

      setSignup({ phase: "active", stepId: "register" });
      const out = await registerName(label, qx, qy, credentialId);

      setSignup({ phase: "active", stepId: "settle" });
      // Tiny artificial settle so the user sees the transition (the receipt
      // wait already happened on the server).
      await new Promise((r) => setTimeout(r, 700));

      saveSession({
        label,
        fullName: `${label}.${PARENT_NAME}`,
        account: out.account,
        credentialId,
      });
      setSignup({ phase: "done" });
      // Hand off.
      setTimeout(() => router.push("/dashboard"), 600);
    } catch (e) {
      const msg = (e as Error).message;
      const stepId =
        signup.phase === "active" ? signup.stepId : "passkey";
      setSignup({ phase: "error", stepId, message: msg });
    }
  }

  return (
    <div className="app-shell landing">
      <Nav />

      <main className="landing-grid">
        {/* ────────── LEFT: pitch ────────── */}
        <section className="pitch">
          <p className="kicker">sign in with name</p>
          <h1 className="hero-title">
            your name<br />
            is the <em>wallet</em>.
          </h1>
          <p className="hero-sub">
            ENSign turns ENS subnames into self-custodial smart accounts.
            Pick a name. Approve with a passkey. <strong>The subname is the wallet</strong> —
            no seed phrase, no extension, no chain to switch.
          </p>

          <ul className="bullets">
            <li>
              <span className="bullet-mark">01</span>
              <div>
                <b>passkey-controlled</b>
                <span>your passkey is the only key. credential never leaves your device.</span>
              </div>
            </li>
            <li>
              <span className="bullet-mark">02</span>
              <div>
                <b>same address everywhere</b>
                <span>canonical factory · cross-chain identity from one ENS name.</span>
              </div>
            </li>
            <li>
              <span className="bullet-mark">03</span>
              <div>
                <b>agents are subnames</b>
                <span>spawn `bot.you.ensign.eth` — capability hash baked into ENS records.</span>
              </div>
            </li>
          </ul>

          {hasSession && signup.phase === "idle" && (
            <p className="resume">
              ⟶ already signed in.{" "}
              <button className="bar-link" onClick={() => router.push("/dashboard")}>
                continue to dashboard
              </button>
            </p>
          )}
        </section>

        {/* ────────── RIGHT: signup card ────────── */}
        <aside className="signup">
          <div className="signup-card">
            <header className="signup-head">
              <span className="signup-eyebrow">claim a name</span>
              <span className="signup-meta">free · sepolia</span>
            </header>

            {signup.phase === "idle" || signup.phase === "error" ? (
              <>
                <p className="signup-prompt">
                  pick a label · we mint <em>{`<label>.${PARENT_NAME}`}</em> bound to
                  a fresh passkey.
                </p>

                <div className="amount-input compact">
                  <input
                    placeholder="alice"
                    value={label}
                    onChange={(e) => setLabel(e.target.value.toLowerCase().trim())}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && label) onSign();
                    }}
                  />
                  <span className="suffix">.{PARENT_NAME}</span>
                </div>

                <button
                  className="action"
                  onClick={onSign}
                  disabled={!label}
                >
                  <span>sign with passkey</span>
                  <span className="action-arrow">→</span>
                </button>

                {signup.phase === "error" && (
                  <div className="err">{signup.message}</div>
                )}
              </>
            ) : (
              <>
                <p className="signup-prompt">
                  signing <em>{label}.{PARENT_NAME}</em> · please don't close the tab
                </p>
                <MultiStepLoader
                  steps={SIGNUP_STEPS}
                  currentId={
                    signup.phase === "active" ? signup.stepId : null
                  }
                  done={signup.phase === "done"}
                  error={null}
                />
                {signup.phase === "done" && (
                  <p className="signup-done">
                    ✓ sealed · routing to dashboard…
                  </p>
                )}
              </>
            )}
          </div>

          <p className="signup-foot">
            no email · no password · the credential never leaves your device
          </p>
        </aside>
      </main>

      <footer className="foot">
        <span className="brand-name">
          EN<em style={{ color: "var(--acc)", fontStyle: "normal" }}>S</em>ign
        </span>
        <span>sepolia · v2 staging</span>
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
