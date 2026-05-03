"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "../app/app.css";
import {
  PARENT_NAME,
  REGISTRY,
  checkLabel,
  createPasskeyForLabel,
  registerName,
  verifyPasskey,
} from "@/lib/ensign";
import { getSession, saveSession } from "@/lib/session";
import { Nav } from "@/components/Nav";
import { MultiStepLoader, type Step } from "@/components/MultiStepLoader";
import { HierarchyTree } from "@/components/HierarchyTree";

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

const SIGNIN_STEPS: Step[] = [
  {
    id: "verify",
    label: "verify passkey",
    description: "prove you hold the credential bound to this name",
  },
  {
    id: "session",
    label: "open dashboard",
    description: "load on-chain account state · route in",
  },
];

type Availability =
  | { state: "idle" }
  | { state: "checking"; label: string }
  | { state: "free"; label: string }
  | {
      state: "taken";
      label: string;
      account: `0x${string}`;
      credentialId: string; // sign-in possible
    }
  | {
      state: "occupied";
      label: string;
      account: `0x${string}`; // taken but no resolver — neither sign-up nor sign-in
    }
  | { state: "invalid"; reason: string };

type Phase =
  | { kind: "idle" }
  | { kind: "active"; mode: "signup" | "signin"; stepId: string }
  | {
      kind: "error";
      mode: "signup" | "signin";
      stepId: string;
      message: string;
    }
  | { kind: "done"; mode: "signup" | "signin" };

const LABEL_RE = /^[a-z0-9-]{1,32}$/;

export default function AppContent() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [avail, setAvail] = useState<Availability>({ state: "idle" });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hasSession, setHasSession] = useState(false);
  const checkRef = useRef<number>(0);

  useEffect(() => {
    setHasSession(!!getSession());
  }, []);

  // Debounced availability check.
  useEffect(() => {
    if (!label) {
      setAvail({ state: "idle" });
      return;
    }
    if (!LABEL_RE.test(label)) {
      setAvail({
        state: "invalid",
        reason: "1–32 chars · lowercase letters, digits, hyphens",
      });
      return;
    }

    const myCheck = ++checkRef.current;
    setAvail({ state: "checking", label });
    const timer = window.setTimeout(async () => {
      if (myCheck !== checkRef.current) return;
      try {
        const status = await checkLabel(label);
        if (myCheck !== checkRef.current) return;
        if (status.state === "free") {
          setAvail({ state: "free", label });
        } else if (status.hasResolver) {
          setAvail({
            state: "taken",
            label,
            account: status.account,
            credentialId: status.credentialId,
          });
        } else {
          setAvail({
            state: "occupied",
            label,
            account: status.account,
          });
        }
      } catch {
        if (myCheck !== checkRef.current) return;
        setAvail({ state: "free", label });
      }
    }, 380);
    return () => window.clearTimeout(timer);
  }, [label]);

  async function onSignUp() {
    if (avail.state !== "free") return;
    try {
      setPhase({ kind: "active", mode: "signup", stepId: "passkey" });
      const { qx, qy, credentialId } = await createPasskeyForLabel(label);

      setPhase({ kind: "active", mode: "signup", stepId: "register" });
      const out = await registerName(label, qx, qy, credentialId);

      setPhase({ kind: "active", mode: "signup", stepId: "settle" });
      await new Promise((r) => setTimeout(r, 700));

      saveSession({
        label,
        fullName: `${label}.${PARENT_NAME}`,
        account: out.account,
        credentialId,
      });
      setPhase({ kind: "done", mode: "signup" });
      setTimeout(() => router.push("/dashboard"), 600);
    } catch (e) {
      const stepId = phase.kind === "active" ? phase.stepId : "passkey";
      setPhase({
        kind: "error",
        mode: "signup",
        stepId,
        message: (e as Error).message,
      });
    }
  }

  async function onSignIn() {
    if (avail.state !== "taken") return;
    try {
      setPhase({ kind: "active", mode: "signin", stepId: "verify" });
      const ok = await verifyPasskey(avail.credentialId);
      if (!ok) throw new Error("authenticator did not return a credential");

      setPhase({ kind: "active", mode: "signin", stepId: "session" });
      saveSession({
        label: avail.label,
        fullName: `${avail.label}.${PARENT_NAME}`,
        account: avail.account,
        credentialId: avail.credentialId,
      });
      await new Promise((r) => setTimeout(r, 350));

      setPhase({ kind: "done", mode: "signin" });
      setTimeout(() => router.push("/dashboard"), 400);
    } catch (e) {
      setPhase({
        kind: "error",
        mode: "signin",
        stepId: phase.kind === "active" ? phase.stepId : "verify",
        message: (e as Error).message,
      });
    }
  }

  const inFlow = phase.kind === "active" || phase.kind === "done";
  const isError = phase.kind === "error";

  // Choose which CTA we're showing.
  const cta =
    avail.state === "taken"
      ? {
          mode: "signin" as const,
          label: "sign in with passkey",
          handler: onSignIn,
          enabled: true,
        }
      : avail.state === "free"
        ? {
            mode: "signup" as const,
            label: "sign up with passkey",
            handler: onSignUp,
            enabled: true,
          }
        : avail.state === "occupied"
          ? {
              mode: "signup" as const,
              label: "name unavailable",
              handler: () => {},
              enabled: false,
            }
          : {
              mode: "signup" as const,
              label: "sign up with passkey",
              handler: onSignUp,
              enabled: false,
            };

  return (
    <div className="app-shell landing">
      <Nav />

      <main className="landing-grid">
        <section className="pitch">
          <p className="kicker">ENS as a Wallet</p>
          <h1 className="hero-title">
            your name<br />
            is the <em>wallet</em>.
          </h1>
          <p className="hero-sub">
            ENSign turns ENS subnames into self-custodial smart accounts.
            Pick a name. Approve with a passkey. <strong>The subname is the wallet</strong>
          </p>

          <ul className="bullets">
            <li>
              <span className="bullet-mark">01</span>
              <div>
                <b>passkey-controlled</b>
                <span>
                  your passkey is the only key. credential never leaves your device.
                </span>
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
                <span>
                  spawn `bot.you.ensign.eth` — capability hash baked into ENS records.
                </span>
              </div>
            </li>
          </ul>

          {hasSession && phase.kind === "idle" && (
            <p className="resume">
              ⟶ already signed in.{" "}
              <button
                className="bar-link"
                onClick={() => router.push("/dashboard")}
              >
                continue to dashboard
              </button>
            </p>
          )}
        </section>

        <aside className="signup">
          <div className="signup-card">
            <header className="signup-head">
              <span className="signup-eyebrow">
                {avail.state === "taken" ? "sign in" : "claim a name"}
              </span>
              {avail.state === "taken" && (
                <span className="signup-meta">existing passkey</span>
              )}
            </header>

            {!inFlow ? (
              <>
                <p className="signup-prompt">
                  {avail.state === "taken" ? (
                    <>
                      <em>
                        {label}.{PARENT_NAME}
                      </em>{" "}
                      is already minted · sign in with the passkey you bound to it.
                    </>
                  ) : avail.state === "occupied" ? (
                    <>
                      <em>
                        {label}.{PARENT_NAME}
                      </em>{" "}
                      is registered but its resolver wasn't wired — pick a different label.
                    </>
                  ) : (
                    <>
                      pick a label · we mint{" "}
                      <em>{`<label>.${PARENT_NAME}`}</em> bound to a fresh passkey.
                    </>
                  )}
                </p>

                <div className="amount-input compact">
                  <input
                    placeholder="alice"
                    value={label}
                    onChange={(e) =>
                      setLabel(e.target.value.toLowerCase().trim())
                    }
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && cta.enabled) cta.handler();
                    }}
                  />
                  <span className="suffix">.{PARENT_NAME}</span>
                </div>

                <AvailabilityRow avail={avail} />

                <button
                  className="action"
                  onClick={cta.handler}
                  disabled={!cta.enabled}
                >
                  <span>{cta.label}</span>
                  <span className="action-arrow">→</span>
                </button>

                {isError && (
                  <div className="err">
                    {phase.message}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="signup-prompt">
                  {phase.kind === "active" || phase.kind === "done"
                    ? phase.mode === "signin"
                      ? <>verifying <em>{label}.{PARENT_NAME}</em> · don't close the tab</>
                      : <>signing <em>{label}.{PARENT_NAME}</em> · don't close the tab</>
                    : null}
                </p>
                <MultiStepLoader
                  steps={
                    phase.kind === "active" || phase.kind === "done"
                      ? phase.mode === "signin"
                        ? SIGNIN_STEPS
                        : SIGNUP_STEPS
                      : SIGNUP_STEPS
                  }
                  currentId={
                    phase.kind === "active" ? phase.stepId : null
                  }
                  done={phase.kind === "done"}
                  error={null}
                />
                {phase.kind === "done" && (
                  <p className="signup-done">
                    ✓ {phase.mode === "signin" ? "signed in" : "sealed"} ·
                    routing to dashboard…
                  </p>
                )}
              </>
            )}
          </div>


          <aside className="ensv2-tag" aria-label="Built on ENS V2">
            <span className="ensv2-tag-eyebrow">// foundation</span>
            <p className="ensv2-tag-title">
              built on top of <em>ENS V2</em>
            </p>
            <a
              className="ensv2-tag-registry"
              href={`https://sepolia.etherscan.io/address/${REGISTRY}`}
              target="_blank"
              rel="noreferrer"
              title="ENSign registry on Sepolia"
            >
              <span className="ensv2-tag-registry-label">ENSign registry</span>
              <span className="ensv2-tag-registry-addr mono">
                {REGISTRY.slice(0, 6)}…{REGISTRY.slice(-4)}
              </span>
              <span className="ensv2-tag-registry-arrow">↗</span>
            </a>
          </aside>
        </aside>
      </main>

      <HierarchyTree />

      <footer className="foot">
        <span className="brand-name">
          EN
          <em style={{ color: "var(--acc)", fontStyle: "normal" }}>S</em>
          ign
        </span>
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

function AvailabilityRow({ avail }: { avail: Availability }) {
  if (avail.state === "idle") {
    return (
      <div className="avail avail--idle">
        <span className="avail-dot" />
        <span>type a label to check availability</span>
      </div>
    );
  }
  if (avail.state === "invalid") {
    return (
      <div className="avail avail--invalid">
        <span className="avail-dot" />
        <span>{avail.reason}</span>
      </div>
    );
  }
  if (avail.state === "checking") {
    return (
      <div className="avail avail--checking">
        <span className="avail-spin" />
        <span>checking on-chain…</span>
      </div>
    );
  }
  if (avail.state === "free") {
    return (
      <div className="avail avail--free">
        <span className="avail-dot" />
        <span>
          available — <strong>sign up</strong> to mint
        </span>
      </div>
    );
  }
  if (avail.state === "occupied") {
    return (
      <div className="avail avail--invalid">
        <span className="avail-dot" />
        <span>
          minted to{" "}
          <a
            href={`https://sepolia.etherscan.io/address/${avail.account}`}
            target="_blank"
            rel="noreferrer"
          >
            {avail.account.slice(0, 6)}…{avail.account.slice(-4)}
          </a>
          {" "}but the <strong>resolver isn't set</strong> — pick another
        </span>
      </div>
    );
  }
  // taken (sign-in path)
  return (
    <div className="avail avail--taken">
      <span className="avail-dot" />
      <span>
        already minted to{" "}
        <a
          href={`https://sepolia.etherscan.io/address/${avail.account}`}
          target="_blank"
          rel="noreferrer"
        >
          {avail.account.slice(0, 6)}…{avail.account.slice(-4)}
        </a>
        {" — "}
        <strong>sign in</strong> instead
      </span>
    </div>
  );
}
