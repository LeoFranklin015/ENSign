"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "../app/system.css";
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
  | { state: "taken"; label: string; account: `0x${string}`; credentialId: string }
  | { state: "occupied"; label: string; account: `0x${string}` }
  | { state: "invalid"; reason: string };

type Phase =
  | { kind: "idle" }
  | { kind: "active"; mode: "signup" | "signin"; stepId: string }
  | { kind: "error"; mode: "signup" | "signin"; stepId: string; message: string }
  | { kind: "done"; mode: "signup" | "signin" };

const LABEL_RE = /^[a-z0-9-]{1,32}$/;

const MORPH_GLYPHS = "abcdef0123456789.·";

/**
 * The signature motion: a name resolving into the address it derives from.
 * Characters settle left to right so it reads as resolution, not a crossfade —
 * which is the product's whole thesis in one glance.
 */
function NameMorph({ name, addr }: { name: string; addr: string }) {
  const [text, setText] = useState(name);
  const [showingName, setShowingName] = useState(true);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let timer = 0;

    const run = (from: string, to: string, done: () => void) => {
      const len = Math.max(from.length, to.length);
      let frame = 0;
      const step = () => {
        const out = Array.from({ length: len }, (_, i) => {
          const settle = i * 1.6;
          if (frame > settle + 8) return to[i] ?? "";
          if (frame > settle) return MORPH_GLYPHS[Math.floor(Math.random() * MORPH_GLYPHS.length)];
          return from[i] ?? "";
        }).join("");
        setText(out);
        frame += 1;
        if (frame < len * 1.6 + 12) raf = requestAnimationFrame(step);
        else { setText(to); done(); }
      };
      step();
    };

    const cycle = () => {
      const [from, to] = showingName ? [name, addr] : [addr, name];
      run(from, to, () => {
        timer = window.setTimeout(() => setShowingName((s) => !s), 2200);
      });
    };
    timer = window.setTimeout(cycle, showingName ? 2200 : 0);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [showingName, name, addr]);

  return <span className="ds-morph">{text}</span>;
}

export default function AppContent() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [avail, setAvail] = useState<Availability>({ state: "idle" });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hasSession, setHasSession] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
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
      setAvail({ state: "invalid", reason: "1–32 chars · a–z, 0–9, hyphens" });
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
          setAvail({ state: "occupied", label, account: status.account });
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
      setPhase({ kind: "error", mode: "signup", stepId, message: (e as Error).message });
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

  // Esc closes the modal, but never mid-flow — a passkey ceremony is in progress.
  useEffect(() => {
    if (!claimOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase.kind === "idle") setClaimOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [claimOpen, phase.kind]);

  const inFlow = phase.kind === "active" || phase.kind === "done";
  const isError = phase.kind === "error";

  const cta =
    avail.state === "taken"
      ? { label: "Sign in with passkey", handler: onSignIn, enabled: true }
      : avail.state === "free"
        ? { label: "Claim this name", handler: onSignUp, enabled: true }
        : avail.state === "occupied"
          ? { label: "Name unavailable", handler: () => {}, enabled: false }
          : { label: "Claim this name", handler: onSignUp, enabled: false };

  const rise = (d: number) => ({ animationDelay: `${d}ms` });
  const previewName = label && LABEL_RE.test(label) ? `${label}.${PARENT_NAME}` : `leo.${PARENT_NAME}`;
  const previewAddr =
    avail.state === "taken" || avail.state === "occupied"
      ? `${avail.account.slice(0, 6)}…${avail.account.slice(-4)}`
      : "0xa742…f3d7";

  return (
    <div className="ds">
      <Nav onClaim={() => setClaimOpen(true)} />

      <section className="ds-wrap ds-hero">
        <div className="ds-mound" aria-hidden />

        <div className="ds-hero-copy ds-hero-copy--solo">
        <h1 className="ds-h1 ds-rise" style={rise(40)}>
          Your name<br />is the <em>wallet</em>.
        </h1>
        <p className="ds-lede ds-rise" style={rise(140)}>
          Pick a subname, approve with your face, and one transaction later you have a
          passkey-controlled account at an address derived from the name itself.
          No seed phrase, no extension, no gas.
        </p>

        <div className="ds-rise" style={{ ...rise(220), marginTop: 30, fontSize: 26 }}>
          <NameMorph name={previewName} addr={previewAddr} />
        </div>

        <div className="ds-hero-cta ds-rise" style={rise(250)}>
          <button className="ds-btn" onClick={() => setClaimOpen(true)}>
            Claim your name <span aria-hidden>→</span>
          </button>
        </div>

        <p className="ds-hero-note ds-rise" style={rise(360)}>
          Live on Sepolia · <b>ENS v2 staging</b> · gas sponsored
        </p>

        {hasSession && phase.kind === "idle" && (
          <p className="ds-resume ds-rise" style={rise(400)}>
            Already signed in.{" "}
            <button onClick={() => router.push("/dashboard")}>Continue to dashboard</button>
          </p>
        )}
        </div>

      </section>

      {/* ── the inversion ── */}
      <section className="ds-band">
        <div className="ds-wrap ds-split">
          <div>
            <p className="ds-eyebrow">The inversion</p>
            <h2 className="ds-h2">
              The address derives from the name, not the other way around.
            </h2>
            <p className="ds-lede">
              Today every wallet starts as a hash, and the name gets bolted on later as a
              label pointing back at it. DNS solved this in 1983. ENSign makes the name the
              foundation — the account address is a pure function of it.
            </p>
            <div className="ds-speclist">
              <div className="ds-spec">
                <span className="ds-spec-k">Account address</span>
                <span className="ds-spec-v">f(name)</span>
              </div>
              <div className="ds-spec">
                <span className="ds-spec-k">Signing key</span>
                <span className="ds-spec-v">passkey in the resolver</span>
              </div>
              <div className="ds-spec">
                <span className="ds-spec-k">Delegation</span>
                <span className="ds-spec-v">a child subname</span>
              </div>
              <div className="ds-spec">
                <span className="ds-spec-k">Revocation</span>
                <span className="ds-spec-v">burn the parent</span>
              </div>
            </div>
          </div>

          <div className="ds-slab" style={{ marginTop: 0 }}>
            <div className="ds-slab-bar">
              <span className="ds-tab ds-tab--on">Name tree</span>
              <span className="ds-live"><i className="ds-dot" /> ENS v2 · Sepolia</span>
            </div>
            <div className="ds-panel" style={{ minHeight: 0 }}>
              <div className="ds-tree">
                <div className="ds-node ds-node--root">
                  {previewName}
                  <span className="ds-node-tag ds-node-tag--live">wallet</span>
                </div>
                <div className="ds-node ds-node--child" style={{ marginTop: 6 }}>
                  trader<span className="ds-node-tag">usdc · 10/day</span>
                </div>
                <div className="ds-node ds-node--child">
                  scout<span className="ds-node-tag">read only</span>
                </div>
                <div className="ds-node ds-node--child">
                  recovery<span className="ds-node-tag ds-node-tag--live">2 of 3</span>
                </div>
                <div className="ds-node ds-node--child" style={{ marginLeft: 52, opacity: 0.75 }}>
                  mom<span className="ds-node-tag">ens name</span>
                </div>
                <div className="ds-node ds-node--child" style={{ marginLeft: 52, opacity: 0.75 }}>
                  email<span className="ds-node-tag">zkemail</span>
                </div>
              </div>
              <p style={{ marginTop: 20, fontSize: 12.5, lineHeight: 1.6, color: "var(--on-dark-soft)" }}>
                Agents and guardians are subnames under yours. The hierarchy <em>is</em> the
                capability tree — not metadata describing one.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── capabilities ── */}
      <section className="ds-band ds-band--dark">
        <div className="ds-wrap">
          <p className="ds-eyebrow">What you get</p>
          <h2 className="ds-h2" style={{ maxWidth: "20ch" }}>
            One name. A wallet, its agents, and its recovery.
          </h2>

          <div className="ds-cards">
            <div className="ds-feat">
              <div className="ds-feat-top">
                <div className="ds-feat-ic">⌘</div>
                <span className="ds-feat-pill">live</span>
              </div>
              <h4>Agents as subnames</h4>
              <p>
                Grant <code>trader.you.{PARENT_NAME}</code> permission to call transfer on a
                token, capped per day and expiring on a date. Validated on-chain before
                anything forwards.
              </p>
            </div>
            <div className="ds-feat">
              <div className="ds-feat-top">
                <div className="ds-feat-ic">◇</div>
                <span className="ds-feat-pill">live</span>
              </div>
              <h4>Recovery as a namespace</h4>
              <p>
                Guardians are names, not addresses — one who rotates wallets keeps working.
                Let a name expire and it drops out of the quorum by itself.
              </p>
            </div>
            <div className="ds-feat">
              <div className="ds-feat-top">
                <div className="ds-feat-ic">↗</div>
                <span className="ds-feat-pill">live</span>
              </div>
              <h4>Sign in anywhere</h4>
              <p>
                A bookmarklet injects an EIP-1193 provider into any page. Anything calling{" "}
                <code>window.ethereum</code> sees a real signer.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── close ── */}
      <section className="ds-band ds-band--close">
        <div className="ds-wrap" style={{ textAlign: "center" }}>
          <h2 className="ds-h2" style={{ maxWidth: "18ch", margin: "0 auto 18px" }}>
            Take a name. Get a wallet.
          </h2>
          <p className="ds-lede" style={{ margin: "0 auto" }}>
            One transaction, sponsored. Nothing to install.
          </p>
          <div className="ds-hero-cta">
            <button className="ds-btn" onClick={() => setClaimOpen(true)}>
              Claim your name <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      </section>

      {claimOpen && (
        <div
          className="ds-modal-bg"
          onClick={() => { if (phase.kind === "idle") setClaimOpen(false); }}
        >
          <div className="ds-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            {phase.kind === "idle" && (
              <button className="ds-modal-x" onClick={() => setClaimOpen(false)} aria-label="Close">
                ×
              </button>
            )}
        <div>
          <div className="ds-claim-head">
            <span className="ds-claim-eyebrow">
              {avail.state === "taken" ? "Sign in" : "Claim a name"}
            </span>
            {avail.state === "taken" && (
              <span className="ds-claim-eyebrow">existing passkey</span>
            )}
          </div>

          {!inFlow ? (
            <>
              <p className="ds-claim-prompt">
                {avail.state === "taken" ? (
                  <>
                    <em>{label}.{PARENT_NAME}</em> is already minted — sign in with the
                    passkey bound to it.
                  </>
                ) : avail.state === "occupied" ? (
                  <>
                    <em>{label}.{PARENT_NAME}</em> is registered but its resolver was never
                    wired. Pick a different label.
                  </>
                ) : (
                  <>Your wallet address is derived from whatever you type here.</>
                )}
              </p>

              <div className="ds-field">
                <input
                  placeholder="alice"
                  value={label}
                  onChange={(e) => setLabel(e.target.value.toLowerCase().trim())}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  onKeyDown={(e) => { if (e.key === "Enter" && cta.enabled) cta.handler(); }}
                />
                <span className="ds-field-suffix">.{PARENT_NAME}</span>
              </div>

              <AvailabilityRow avail={avail} />

              <button
                className="ds-btn ds-btn--block"
                onClick={cta.handler}
                disabled={!cta.enabled}
              >
                {cta.label} <span aria-hidden>→</span>
              </button>

              {isError && <div className="ds-err">{phase.message}</div>}
            </>
          ) : (
            <>
              <p className="ds-claim-prompt">
                {phase.kind === "active" || phase.kind === "done" ? (
                  phase.mode === "signin" ? (
                    <>Verifying <em>{label}.{PARENT_NAME}</em> — don&apos;t close the tab.</>
                  ) : (
                    <>Minting <em>{label}.{PARENT_NAME}</em> — don&apos;t close the tab.</>
                  )
                ) : null}
              </p>
              <MultiStepLoader
                steps={
                  phase.kind === "active" || phase.kind === "done"
                    ? phase.mode === "signin" ? SIGNIN_STEPS : SIGNUP_STEPS
                    : SIGNUP_STEPS
                }
                currentId={phase.kind === "active" ? phase.stepId : null}
                done={phase.kind === "done"}
                error={null}
              />
              {phase.kind === "done" && (
                <p className="ds-claim-prompt" style={{ marginTop: 16, marginBottom: 0 }}>
                  ✓ {phase.mode === "signin" ? "Signed in" : "Sealed"} — opening dashboard…
                </p>
              )}
            </>
          )}
        </div>

          </div>
        </div>
      )}

      <div className="ds-wrap">
        <footer className="ds-foot">
          <span>ENSign · ENS v2 on Sepolia</span>
          <span className="ds-foot-sp">
            <a href="/pitch">Pitch</a>
            <a href="https://github.com/LeoFranklin015/ENSign" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a
              href={`https://sepolia.etherscan.io/address/${REGISTRY}`}
              target="_blank"
              rel="noreferrer"
            >
              Registry {REGISTRY?.slice(0, 6)}…{REGISTRY?.slice(-4)}
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

function AvailabilityRow({ avail }: { avail: Availability }) {
  if (avail.state === "idle") {
    return (
      <div className="ds-avail">
        <span className="ds-avail-dot" />
        <span>type a label to check availability</span>
      </div>
    );
  }
  if (avail.state === "invalid") {
    return (
      <div className="ds-avail ds-avail--bad">
        <span className="ds-avail-dot" />
        <span>{avail.reason}</span>
      </div>
    );
  }
  if (avail.state === "checking") {
    return (
      <div className="ds-avail">
        <span className="ds-avail-spin" />
        <span>checking on-chain…</span>
      </div>
    );
  }
  if (avail.state === "free") {
    return (
      <div className="ds-avail ds-avail--free">
        <span className="ds-avail-dot" />
        <span>available — <strong>yours to claim</strong></span>
      </div>
    );
  }
  if (avail.state === "occupied") {
    return (
      <div className="ds-avail ds-avail--bad">
        <span className="ds-avail-dot" />
        <span>
          minted to{" "}
          <a href={`https://sepolia.etherscan.io/address/${avail.account}`} target="_blank" rel="noreferrer">
            {avail.account.slice(0, 6)}…{avail.account.slice(-4)}
          </a>{" "}
          — resolver unset
        </span>
      </div>
    );
  }
  return (
    <div className="ds-avail ds-avail--taken">
      <span className="ds-avail-dot" />
      <span>
        minted to{" "}
        <a href={`https://sepolia.etherscan.io/address/${avail.account}`} target="_blank" rel="noreferrer">
          {avail.account.slice(0, 6)}…{avail.account.slice(-4)}
        </a>{" "}
        — <strong>sign in</strong>
      </span>
    </div>
  );
}
