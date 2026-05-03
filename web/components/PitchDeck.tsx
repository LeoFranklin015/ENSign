"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import "../app/app.css";
import { HierarchyTree } from "@/components/HierarchyTree";

/// Pitch deck for the ETHGlobal submission.
///
/// One full-viewport poster per concept, scroll-snapped vertically.
/// Each slide reveals its content in a stagger when it enters the viewport
/// (IntersectionObserver flips a `slide--in` class), and a thin lime
/// progress bar + slide counter at the top tracks position through the deck.

const SLIDES = [
  { id: "cover", n: "00", label: "cover" },
  { id: "problem", n: "01", label: "problem" },
  { id: "solution", n: "02", label: "the flip" },
  { id: "ens-v2", n: "03", label: "ens v2" },
  { id: "lifecycle", n: "04", label: "architecture" },
  { id: "perm", n: "05", label: "permission" },
  { id: "agents", n: "06", label: "agents" },
];

const setDelay = (ms: number): CSSProperties =>
  ({ ["--d" as never]: `${ms}ms` } as CSSProperties);

export default function PitchDeck() {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const idx = refs.current.findIndex((r) => r === entry.target);
          if (idx < 0) return;
          if (entry.intersectionRatio >= 0.55) {
            setActive(idx);
            (entry.target as HTMLElement).classList.add("slide--in");
          }
        });
      },
      { threshold: [0, 0.25, 0.5, 0.55, 0.75, 1] },
    );
    refs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const setRef = (i: number) => (el: HTMLElement | null) => {
    refs.current[i] = el;
  };

  const progress = ((active + 1) / SLIDES.length) * 100;
  const total = SLIDES[SLIDES.length - 1].n;

  return (
    <div className="deck">
      <header className="deck-bar">
        <Link href="/" className="deck-brand">
          <span className="brand-glyph" aria-hidden="true" />
          <span>
            EN<em>S</em>ign · pitch
          </span>
        </Link>
        <div className="deck-meta">
          <span className="deck-counter mono">
            {SLIDES[active].n} <span className="deck-counter-sep">/</span> {total}
          </span>
          <span className="deck-section mono">// {SLIDES[active].label}</span>
        </div>
        <div
          className="deck-progress"
          style={{ width: `${progress}%` }}
          aria-hidden="true"
        />
      </header>

      <main className="deck-main">
        {/* ─────────────── 00 · COVER ─────────────── */}
        <section ref={setRef(0)} id="cover" className="slide slide--cover">
          <CornerBrackets />

          <div className="cover-grid">
            <div className="cover-left">
              <span className="cover-logo" style={setDelay(0)} aria-hidden="true">
                <span className="cover-logo-glyph" />
              </span>
              <h1 className="cover-display" style={setDelay(160)}>
                EN<em>S</em>ign
              </h1>
              <p className="cover-tag" style={setDelay(440)}>
                your name <em>is</em> the wallet.
              </p>
            </div>

            {/* product mockup — mirror of the actual /embed sign-in card */}
            <aside
              className="cover-mock"
              style={setDelay(640)}
              aria-hidden="true"
            >
              <div className="cover-mock-card">
                <header className="cover-mock-bar">
                  <div className="cover-mock-mark">
                    <span className="cover-mock-mark-glyph" />
                    <span>ENSign</span>
                  </div>
                  <span className="cover-mock-close">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </span>
                </header>
                <div className="cover-mock-body">
                  <span className="cover-mock-eyebrow">connection request</span>
                  <h3 className="cover-mock-title">Sign in with your name</h3>
                  <p className="cover-mock-desc">
                    Type the ENSign name you want to share with this site.
                  </p>
                  <div className="cover-mock-input">
                    <span className="cover-mock-input-value">
                      <span className="cover-mock-typewriter">leo</span>
                      <span className="cover-mock-caret" />
                    </span>
                    <span className="cover-mock-input-suffix">.ensign.eth</span>
                  </div>
                  <button type="button" className="cover-mock-cta" tabIndex={-1}>
                    <span>Continue</span>
                    <span className="cover-mock-cta-arrow">→</span>
                  </button>
                </div>
                <footer className="cover-mock-foot">
                  Secured by <strong>ENSign</strong>
                </footer>
              </div>
            </aside>
          </div>

          <p className="slide-foot mono" style={setDelay(1080)}>
            scroll to begin ↓
          </p>
        </section>

        {/* ─────────────── 01 · PROBLEM ─────────────── */}
        <section ref={setRef(1)} id="problem" className="slide slide--problem">
          <CornerBrackets />

          <div className="problem-grid">
            <div className="problem-copy">
              <span className="slide-eyebrow mono" style={setDelay(0)}>
                // 01 · problem
              </span>
              <h2 className="slide-h2" style={setDelay(180)}>
                to be <em>someone</em>,<br />
                you need everything else <em>first</em>.
              </h2>
              <p className="slide-lede" style={setDelay(360)}>
                Web3 onboarding takes <strong>six</strong> steps before a person
                has an identity. Every step assumes the previous one is done —
                and step zero (already on-chain) is the one most people don't
                have.
              </p>
              <p className="slide-callout" style={setDelay(1280)}>
                identity should be <em>step one</em>, not step six.
              </p>
            </div>

            <ol className="problem-flow">
              <li style={setDelay(420)}>
                <span className="flow-num mono">01</span>
                <div>
                  <strong>install a wallet extension</strong>
                  <span className="flow-sub mono">MetaMask, Rabby, …</span>
                </div>
              </li>
              <li style={setDelay(540)}>
                <span className="flow-num mono">02</span>
                <div>
                  <strong>save a 12-word seed</strong>
                  <span className="flow-sub mono">don't lose it · don't get phished</span>
                </div>
              </li>
              <li style={setDelay(660)}>
                <span className="flow-num mono">03</span>
                <div>
                  <strong>get a 0x address</strong>
                  <span className="flow-sub mono">unmemorable, unmemoizable</span>
                </div>
              </li>
              <li style={setDelay(780)}>
                <span className="flow-num mono">04</span>
                <div>
                  <strong>buy ETH on a CEX</strong>
                  <span className="flow-sub mono">KYC, withdrawal limits</span>
                </div>
              </li>
              <li style={setDelay(900)}>
                <span className="flow-num mono">05</span>
                <div>
                  <strong>pay gas to register a name</strong>
                  <span className="flow-sub mono">vitalik.eth costs ETH</span>
                </div>
              </li>
              <li style={setDelay(1020)}>
                <span className="flow-num mono">06</span>
                <div>
                  <strong>finally — an identity</strong>
                  <span className="flow-sub mono">five steps too late</span>
                </div>
              </li>
            </ol>
          </div>
        </section>

        {/* ─────────────── 02 · SOLUTION ─────────────── */}
        <section ref={setRef(2)} id="solution" className="slide slide--solution">
          <CornerBrackets />

          <div className="solution-grid">
            <div className="solution-copy">
              <span className="slide-eyebrow mono" style={setDelay(0)}>
                // 02 · the flip
              </span>
              <h2 className="slide-h2" style={setDelay(180)}>
                we collapsed it<br />
                to <em>one</em>.
              </h2>
              <p className="slide-lede" style={setDelay(360)}>
                Pick a name. Approve with a passkey. The address derives. The
                smart account deploys. The gas is sponsored. There's nothing
                left for the user to do.
              </p>
              <ul className="slide-bullets" style={setDelay(560)}>
                <li>
                  <strong>passkey-controlled.</strong> credential never leaves
                  your device.
                </li>
                <li>
                  <strong>sponsored.</strong> Pimlico paymaster covers gas.
                </li>
                <li>
                  <strong>portable.</strong> same address on every EVM chain
                  the canonical factory is on.
                </li>
              </ul>
            </div>

            <aside className="solution-mock" style={setDelay(480)}>
              <div className="mock-shell">
                <header className="mock-bar">
                  <span className="mock-dot" />
                  <span className="mock-dot" />
                  <span className="mock-dot" />
                  <span className="mock-bar-title mono">claim a name</span>
                </header>
                <div className="mock-body">
                  <span className="mock-eyebrow mono">// claim a name</span>
                  <div className="mock-input">
                    <span className="mock-input-value">
                      <span className="mock-typewriter">leo</span>
                      <span className="mock-caret" aria-hidden="true" />
                    </span>
                    <span className="mock-input-suffix mono">.ensign.eth</span>
                  </div>
                  <span className="mock-avail mono">
                    <span className="mock-avail-dot" /> available
                  </span>
                  <button className="mock-cta">
                    sign up with passkey <span>→</span>
                  </button>
                  <ul className="mock-meta mono">
                    <li>↳ smart account: deterministic</li>
                    <li>↳ gas: sponsored by paymaster</li>
                    <li>↳ time-to-first-tx: ~ 4 seconds</li>
                  </ul>
                </div>
              </div>
              <span className="mock-caption mono">// what the user sees</span>
            </aside>
          </div>
        </section>

        {/* ─────────────── 03 · ENS V2 USAGE ─────────────── */}
        <section ref={setRef(3)} id="ens-v2" className="slide slide--v2">
          <CornerBrackets />

          <div className="v2-grid">
            <div className="v2-copy">
              <span className="slide-eyebrow mono" style={setDelay(0)}>
                // 03 · what ENS V2 unlocks
              </span>
              <h2 className="slide-h2" style={setDelay(180)}>
                ENS V2 made names<br />
                <em>programmable</em>.
              </h2>
              <p className="slide-lede" style={setDelay(360)}>
                V1 was a directory. V2 is infrastructure — every name carries
                its own subregistry, its own resolver, its own permission space.
                We use all three.
              </p>
              <ul className="v2-bullets" style={setDelay(540)}>
                <li>
                  <strong>subregistries.</strong> every name owns its children.
                </li>
                <li>
                  <strong>writable resolvers.</strong> addr + cred + perm
                  written at mint.
                </li>
                <li>
                  <strong>hierarchy = permission.</strong> burn parent, kill
                  leaves.
                </li>
              </ul>
            </div>

            <div className="v2-tree-frame" style={setDelay(420)}>
              <HierarchyTree />
            </div>
          </div>
        </section>

        {/* ─────────────── 04 · ARCHITECTURE DIAGRAM ─────────────── */}
        <section ref={setRef(4)} id="lifecycle" className="slide slide--arch">
          <CornerBrackets />

          <header className="arch-head">
            <span className="slide-eyebrow mono" style={setDelay(0)}>
              // 04 · architecture
            </span>
            <h2 className="lifecycle-title" style={setDelay(160)}>
              how a name becomes a wallet,<br />
              then a <em>tx</em>.
            </h2>
            <p className="lifecycle-sub" style={setDelay(320)}>
              Same components, different paths through them.
            </p>
          </header>

          {/* Two flows. Two horizontal chains. No infra middle layer. */}
          <div className="arch-canvas-wrap" style={setDelay(480)}>
            <svg
              className="arch-canvas arch-canvas--simple"
              viewBox="0 0 1280 560"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="ENSign architecture"
            >
              <defs>
                <marker
                  id="arch-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill="#b8ff3a" />
                </marker>
              </defs>

              {/* ─── FLOW 1 · MINT (3 boxes) ────────────────────────── */}
              <text x="60" y="60" className="arch-flow-label">
                // flow 01 · mint a name
              </text>
              <line
                x1="60"
                y1="74"
                x2="1220"
                y2="74"
                className="arch-flow-rule"
              />

              {/* user */}
              <g className="arch-node arch-node--user">
                <rect x="60" y="110" width="220" height="120" rx="10" />
                <text x="170" y="148" className="arch-node-title">user</text>
                <text x="170" y="172" className="arch-node-sub">passkey</text>
                <text x="170" y="194" className="arch-node-meta">creates (qx, qy, credId)</text>
                <text x="170" y="212" className="arch-node-meta">on-device · never leaves</text>
              </g>

              {/* Registry Contract — ENSign + ENS V2 records combined */}
              <g className="arch-node arch-node--key">
                <rect x="500" y="110" width="220" height="120" rx="10" />
                <text x="610" y="148" className="arch-node-title">Registry Contract</text>
                <text x="610" y="172" className="arch-node-sub">ENS V2 subname + records</text>
                <text x="610" y="194" className="arch-node-meta">addr(node) → smart account</text>
                <text x="610" y="212" className="arch-node-meta">text(node, "credId") → passkey</text>
              </g>

              {/* Smart Account deployed */}
              <g className="arch-node arch-node--key">
                <rect x="940" y="110" width="220" height="120" rx="10" />
                <text x="1050" y="148" className="arch-node-title">Smart Account</text>
                <text x="1050" y="172" className="arch-node-sub">deployed</text>
                <text x="1050" y="194" className="arch-node-meta">leo.ensign.eth</text>
                <text x="1050" y="212" className="arch-node-meta">≡ 0xceF0…F3c7</text>
              </g>

              {/* arrows for flow 1 */}
              <path
                d="M 280 170 L 500 170"
                className="arch-edge arch-edge--primary"
                pathLength={1}
                markerEnd="url(#arch-arrow)"
              />
              <text x="390" y="160" className="arch-edge-label" textAnchor="middle">register(label, qx, qy, credId)</text>

              <path
                d="M 720 170 L 940 170"
                className="arch-edge arch-edge--primary"
                pathLength={1}
                markerEnd="url(#arch-arrow)"
              />
              <text x="830" y="160" className="arch-edge-label" textAnchor="middle">deploys deterministic acct</text>

              {/* ─── FLOW 2 · RESOLVE + TX (5 boxes) ───────────────────── */}
              <text x="60" y="320" className="arch-flow-label">
                // flow 02 · resolve + sign + tx
              </text>
              <line
                x1="60"
                y1="334"
                x2="1220"
                y2="334"
                className="arch-flow-rule"
              />

              {/* user — same x as flow 1 (60–280) */}
              <g className="arch-node arch-node--user">
                <rect x="60" y="370" width="220" height="120" rx="10" />
                <text x="170" y="408" className="arch-node-title" textAnchor="middle">user</text>
                <text x="170" y="432" className="arch-node-sub" textAnchor="middle">types "leo"</text>
                <text x="170" y="454" className="arch-node-meta" textAnchor="middle">wants to send a tx</text>
                <text x="170" y="472" className="arch-node-meta" textAnchor="middle">browser holds the passkey</text>
              </g>

              {/* Registry resolve — shifted to give the passkey breathing room */}
              <g className="arch-node">
                <rect x="353" y="370" width="220" height="120" rx="10" />
                <text x="463" y="408" className="arch-node-title" textAnchor="middle">Registry Contract</text>
                <text x="463" y="432" className="arch-node-sub" textAnchor="middle">resolve</text>
                <text x="463" y="454" className="arch-node-meta" textAnchor="middle">read addr(node)</text>
                <text x="463" y="472" className="arch-node-meta" textAnchor="middle">read text(node, "credId")</text>
              </g>

              {/* Passkey — proper full-size box with even spacing */}
              <g className="arch-node arch-node--key">
                <rect x="646" y="370" width="220" height="120" rx="10" />
                <text x="756" y="408" className="arch-node-title" textAnchor="middle">passkey</text>
                <text x="756" y="432" className="arch-node-sub" textAnchor="middle">triggered by credId</text>
                <text x="756" y="454" className="arch-node-meta" textAnchor="middle">face / fingerprint</text>
                <text x="756" y="472" className="arch-node-meta" textAnchor="middle">P-256 assertion</text>
              </g>

              {/* Smart Account — same x as flow 1 (940–1160) */}
              <g className="arch-node arch-node--key">
                <rect x="940" y="370" width="220" height="120" rx="10" />
                <text x="1050" y="408" className="arch-node-title" textAnchor="middle">Smart Account</text>
                <text x="1050" y="432" className="arch-node-sub" textAnchor="middle">signs userOpHash</text>
                <text x="1050" y="454" className="arch-node-meta" textAnchor="middle">P-256 sig wraps the tx</text>
                <text x="1050" y="472" className="arch-node-meta" textAnchor="middle">tx broadcasts</text>
              </g>

              {/* arrows for flow 2 — three equal 73px gaps */}
              <path
                d="M 280 430 L 353 430"
                className="arch-edge arch-edge--primary"
                pathLength={1}
                markerEnd="url(#arch-arrow)"
              />
              <text x="316" y="420" className="arch-edge-label" textAnchor="middle">lookup</text>

              <path
                d="M 573 430 L 646 430"
                className="arch-edge arch-edge--primary"
                pathLength={1}
                markerEnd="url(#arch-arrow)"
              />
              <text x="609" y="420" className="arch-edge-label" textAnchor="middle">credId</text>

              <path
                d="M 866 430 L 940 430"
                className="arch-edge arch-edge--primary"
                pathLength={1}
                markerEnd="url(#arch-arrow)"
              />
              <text x="903" y="420" className="arch-edge-label" textAnchor="middle">sig</text>

              {/* Animated pulse on flow 2 */}
              <path
                id="arch-flow-tx-line"
                d="M 60 430 L 1160 430"
                fill="none"
                stroke="none"
              />
              <circle r="5" fill="#b8ff3a" className="arch-pulse">
                <animateMotion dur="4s" repeatCount="indefinite" begin="2.2s">
                  <mpath href="#arch-flow-tx-line" />
                </animateMotion>
              </circle>
            </svg>
          </div>
        </section>

        {/* ─────────────── 05 · PERMISSION ANATOMY ─────────────── */}
        <section ref={setRef(5)} id="perm" className="slide slide--perm">
          <CornerBrackets />

          <header className="perm-head">
            <span className="slide-eyebrow mono" style={setDelay(0)}>
              // 05 · permission · on-chain
            </span>
            <h2 className="lifecycle-title" style={setDelay(160)}>
              anatomy of an <em>agent</em>.
            </h2>
            <p className="lifecycle-sub" style={setDelay(320)}>
              One permission record, granted from a parent name to its child.
              Stored under the child's ENS record. Read by the contract before
              every call.
            </p>
          </header>

          <div className="perm-slide-grid" style={setDelay(440)}>
            {/* Permission record card — like /agents shows */}
            <article className="perm-card perm-card--big" style={setDelay(520)}>
              <header className="perm-card-head">
                <span className="perm-eyebrow mono">// permission record</span>
                <span className="perm-status">
                  <span className="perm-status-dot" /> active
                </span>
              </header>

              {/* parent → child grant chain */}
              <div className="perm-chain">
                <span className="perm-chain-eyebrow mono">// parent</span>
                <span className="perm-chain-parent">
                  leo<em>.ensign.eth</em>
                </span>
                <span className="perm-chain-arrow" aria-hidden="true">↓</span>
                <span className="perm-chain-eyebrow mono">// grants</span>
              </div>

              <h3 className="perm-name">
                trader<em>.leo.ensign.eth</em>
              </h3>
              <span className="perm-spender mono">spender → 0xab12…cd34</span>

              <dl className="perm-fields">
                <div>
                  <dt>target</dt>
                  <dd className="mono">USDC</dd>
                </div>
                <div>
                  <dt>selector</dt>
                  <dd className="mono">transfer(address,uint256)</dd>
                </div>
                <div>
                  <dt>cap</dt>
                  <dd className="mono">10 / day</dd>
                </div>
                <div>
                  <dt>expires</dt>
                  <dd className="mono">in 7d</dd>
                </div>
                <div>
                  <dt>parent</dt>
                  <dd className="mono">leo.ensign.eth</dd>
                </div>
              </dl>
            </article>

            {/* Field-by-field explanation */}
            <ul className="perm-explain" style={setDelay(680)}>
              <li>
                <span className="perm-explain-key mono">target</span>
                <span>only this contract can be called. wildcard supported.</span>
              </li>
              <li>
                <span className="perm-explain-key mono">selector</span>
                <span>only this 4-byte function. or wildcard / native ETH.</span>
              </li>
              <li>
                <span className="perm-explain-key mono">cap</span>
                <span>spend ceiling per period. tracked on-chain.</span>
              </li>
              <li>
                <span className="perm-explain-key mono">expires</span>
                <span>auto-revoke at this timestamp.</span>
              </li>
              <li>
                <span className="perm-explain-key mono">parent</span>
                <span>
                  the name that granted this permission. burn the parent →
                  this child loses authority.
                </span>
              </li>
            </ul>
          </div>

          <article className="recur-card perm-recur-card" style={setDelay(880)}>
            <span className="perm-eyebrow mono">// recursion</span>
            <pre className="recur-tree mono">
{`leo.ensign.eth                       (wallet)
   ↳ trader.leo.ensign.eth            (agent · USDC · 10/day)
       ↳ scout.trader.leo.ensign.eth  (sub-agent · narrower scope)`}
            </pre>
          </article>
        </section>
        {/* ─────────────── 06 · AGENTS ─────────────── */}
        <section ref={setRef(6)} id="agents" className="slide slide--arch">
          <CornerBrackets />

          <header className="arch-head">
            <span className="slide-eyebrow mono" style={setDelay(0)}>
              // 06 · agents
            </span>
            <h2 className="lifecycle-title" style={setDelay(160)}>
              delegate by name.<br />
              revoke <em>by name</em>.
            </h2>
            <p className="lifecycle-sub" style={setDelay(320)}>
              Subnames of subnames become agents — scoped, on-chain, revocable.
            </p>
          </header>

          <div className="arch-canvas-wrap" style={setDelay(480)}>
            <svg
              className="arch-canvas arch-canvas--simple"
              viewBox="0 0 1280 560"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="ENSign agents architecture"
            >
              <defs>
                <marker
                  id="agents-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill="#b8ff3a" />
                </marker>
              </defs>

              {/* ─── FLOW 1 · grant permission (3 boxes) ─── */}
              <text x="60" y="60" className="arch-flow-label">
                // flow 01 · grant a permission
              </text>
              <line x1="60" y1="74" x2="1220" y2="74" className="arch-flow-rule" />

              {/* user */}
              <g className="arch-node arch-node--user">
                <rect x="60" y="110" width="220" height="120" rx="10" />
                <text x="170" y="148" className="arch-node-title" textAnchor="middle">user</text>
                <text x="170" y="172" className="arch-node-sub" textAnchor="middle">leo.ensign.eth</text>
                <text x="170" y="194" className="arch-node-meta" textAnchor="middle">picks target · cap · expiry</text>
                <text x="170" y="212" className="arch-node-meta" textAnchor="middle">picks an agent address</text>
              </g>

              {/* AgentRegistry */}
              <g className="arch-node arch-node--key">
                <rect x="500" y="110" width="220" height="120" rx="10" />
                <text x="610" y="148" className="arch-node-title" textAnchor="middle">AgentRegistry</text>
                <text x="610" y="172" className="arch-node-sub" textAnchor="middle">approve(permission)</text>
                <text x="610" y="194" className="arch-node-meta" textAnchor="middle">mints agent subname</text>
                <text x="610" y="212" className="arch-node-meta" textAnchor="middle">stores permission hash</text>
              </g>

              {/* Agent subname */}
              <g className="arch-node arch-node--key">
                <rect x="940" y="110" width="220" height="120" rx="10" />
                <text x="1050" y="148" className="arch-node-title" textAnchor="middle">trader.leo.ensign.eth</text>
                <text x="1050" y="172" className="arch-node-sub" textAnchor="middle">agent name</text>
                <text x="1050" y="194" className="arch-node-meta" textAnchor="middle">addr → 0xab12…cd34</text>
                <text x="1050" y="212" className="arch-node-meta" textAnchor="middle">text(perm) → 0x9c…0d</text>
              </g>

              {/* arrows */}
              <path d="M 280 170 L 500 170" className="arch-edge arch-edge--primary" pathLength={1} markerEnd="url(#agents-arrow)" />
              <text x="390" y="160" className="arch-edge-label" textAnchor="middle">approve(permission)</text>

              <path d="M 720 170 L 940 170" className="arch-edge arch-edge--primary" pathLength={1} markerEnd="url(#agents-arrow)" />
              <text x="830" y="160" className="arch-edge-label" textAnchor="middle">mints subname + records</text>

              {/* ─── FLOW 2 · agent acts (4 boxes) ─── */}
              <text x="60" y="320" className="arch-flow-label">
                // flow 02 · agent acts
              </text>
              <line x1="60" y1="334" x2="1220" y2="334" className="arch-flow-rule" />

              {/* agent EOA */}
              <g className="arch-node arch-node--user">
                <rect x="60" y="370" width="220" height="120" rx="10" />
                <text x="170" y="408" className="arch-node-title" textAnchor="middle">agent EOA</text>
                <text x="170" y="432" className="arch-node-sub" textAnchor="middle">0xab12…cd34</text>
                <text x="170" y="454" className="arch-node-meta" textAnchor="middle">signs the call</text>
                <text x="170" y="472" className="arch-node-meta" textAnchor="middle">no funds, just authority</text>
              </g>

              {/* AgentRegistry validates */}
              <g className="arch-node">
                <rect x="353" y="370" width="220" height="120" rx="10" />
                <text x="463" y="408" className="arch-node-title" textAnchor="middle">AgentRegistry</text>
                <text x="463" y="432" className="arch-node-sub" textAnchor="middle">validate</text>
                <text x="463" y="454" className="arch-node-meta" textAnchor="middle">target · selector · cap match?</text>
                <text x="463" y="472" className="arch-node-meta" textAnchor="middle">not expired? not revoked?</text>
              </g>

              {/* Smart Account */}
              <g className="arch-node arch-node--key">
                <rect x="646" y="370" width="220" height="120" rx="10" />
                <text x="756" y="408" className="arch-node-title" textAnchor="middle">Smart Account</text>
                <text x="756" y="432" className="arch-node-sub" textAnchor="middle">leo.ensign.eth</text>
                <text x="756" y="454" className="arch-node-meta" textAnchor="middle">funds live here</text>
                <text x="756" y="472" className="arch-node-meta" textAnchor="middle">executes via the registry</text>
              </g>

              {/* target */}
              <g className="arch-node">
                <rect x="940" y="370" width="220" height="120" rx="10" />
                <text x="1050" y="408" className="arch-node-title" textAnchor="middle">smart contract</text>
                <text x="1050" y="432" className="arch-node-sub" textAnchor="middle">USDC · Uniswap · …</text>
                <text x="1050" y="454" className="arch-node-meta" textAnchor="middle">tx executes</text>
                <text x="1050" y="472" className="arch-node-meta" textAnchor="middle">paid by leo's account</text>
              </g>

              {/* arrows for flow 2 */}
              <path d="M 280 430 L 353 430" className="arch-edge arch-edge--primary" pathLength={1} markerEnd="url(#agents-arrow)" />
              <text x="316" y="420" className="arch-edge-label" textAnchor="middle">executeBatch</text>

              <path d="M 573 430 L 646 430" className="arch-edge arch-edge--primary" pathLength={1} markerEnd="url(#agents-arrow)" />
              <text x="609" y="420" className="arch-edge-label" textAnchor="middle">forward</text>

              <path d="M 866 430 L 940 430" className="arch-edge arch-edge--primary" pathLength={1} markerEnd="url(#agents-arrow)" />
              <text x="903" y="420" className="arch-edge-label" textAnchor="middle">call</text>

              {/* pulse on flow 2 */}
              <path id="agents-flow-line" d="M 60 430 L 1160 430" fill="none" stroke="none" />
              <circle r="5" fill="#b8ff3a" className="arch-pulse">
                <animateMotion dur="4.4s" repeatCount="indefinite" begin="2.4s">
                  <mpath href="#agents-flow-line" />
                </animateMotion>
              </circle>
            </svg>
          </div>
        </section>

      </main>
    </div>
  );
}

/// Minimal corner brackets, drawn on every slide. Adds an editorial frame
/// without touching the slide's content layout.
function CornerBrackets() {
  return (
    <>
      <span className="bracket bracket--tl" aria-hidden="true" />
      <span className="bracket bracket--tr" aria-hidden="true" />
      <span className="bracket bracket--bl" aria-hidden="true" />
      <span className="bracket bracket--br" aria-hidden="true" />
    </>
  );
}
