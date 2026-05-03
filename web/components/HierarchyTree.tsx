"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/// Animated hierarchy diagram for the landing page.
///
///                  looooo.eth                          ← parent (ENS V2)
///              ┌────────┴────────┐
///              ▼                 ▼
///       leo.looooo.eth     alice.looooo.eth            ← wallets (siblings)
///              │                                         (alice has no agents)
///        ┌─────┼─────┐
///        ▼     ▼     ▼
///      trader  dca  reporter                           ← agents (perms)
///
/// Reveal: IntersectionObserver flips a single class on the section, the
/// child cards/lines run staggered keyframes via per-element CSS vars.
/// Post-reveal: small lime dots travel down each connector continuously
/// to suggest "data / authority flowing downstream."
export function HierarchyTree() {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.18 },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  const setDelay = (ms: number): CSSProperties =>
    ({ ["--d" as never]: `${ms}ms` } as CSSProperties);

  return (
    <section
      ref={ref}
      className={`tree-section${visible ? " tree--in" : ""}`}
      aria-label="ENS hierarchy diagram"
    >
      <header className="tree-head">
        <p className="kicker">hierarchy</p>
        <h2 className="tree-title">
          one name,<br />
          infinite <em>delegation</em>.
        </h2>
        <p className="tree-sub">
          ENS subnames cascade. Your name is the wallet — its subnames are
          agents with on-chain permissions, scoped and revocable.
        </p>
      </header>

      <div className="tree-stage">
        {/* ─── PARENT TIER ─── */}
        <div className="tree-tier">
          <article className="tree-node tree-node--parent" style={setDelay(0)}>
            <span className="tree-node-eyebrow">// ens v2 root</span>
            <h3 className="tree-node-name">
              looooo<em>.eth</em>
            </h3>
            <span className="tree-node-meta mono">parent registry</span>
          </article>
        </div>

        {/* ─── CONNECTOR : parent → 2 wallets ─── */}
        <div className="tree-branch tree-branch--two" style={setDelay(280)}>
          <svg viewBox="0 0 600 90" preserveAspectRatio="none" aria-hidden="true">
            <path d="M300 0 L300 30" className="tree-line-path" pathLength={1} />
            <path d="M180 30 L420 30" className="tree-line-path" pathLength={1} />
            <path d="M180 30 L180 90" className="tree-line-path" pathLength={1} />
            <path d="M420 30 L420 90" className="tree-line-path" pathLength={1} />
          </svg>
          <span className="tree-branch-pulse tree-branch-pulse--two-l" />
          <span className="tree-branch-pulse tree-branch-pulse--two-r" />
        </div>

        {/* ─── WALLETS TIER : leo + alice ─── */}
        <div className="tree-wallets-row">
          <article
            className="tree-node tree-node--wallet"
            style={setDelay(640)}
          >
            <span className="tree-node-eyebrow">// your wallet</span>
            <h3 className="tree-node-name">
              leo<em>.looooo.eth</em>
            </h3>
            <span className="tree-node-meta mono">
              0xceF0…F3c7 · smart account
            </span>
            <div className="tree-node-tags">
              <span className="tree-tag">passkey</span>
              <span className="tree-tag">erc-4337</span>
              <span className="tree-tag">3 agents</span>
            </div>
          </article>

          <article
            className="tree-node tree-node--wallet tree-node--wallet-quiet"
            style={setDelay(760)}
          >
            <span className="tree-node-eyebrow">// sibling wallet</span>
            <h3 className="tree-node-name">
              alice<em>.looooo.eth</em>
            </h3>
            <span className="tree-node-meta mono">
              0x91A2…b3d4 · smart account
            </span>
            <div className="tree-node-tags">
              <span className="tree-tag tree-tag--quiet">passkey</span>
              <span className="tree-tag tree-tag--quiet">no agents</span>
            </div>
          </article>
        </div>

        {/* ─── BRANCH from leo's column → 3 agents (asymmetric fan) ───
             Stem starts at x=150 (25% — leo's column-1 center in the wallets
             grid), curves outward at y≈40, joins a horizontal at y=70 that
             spans the agent row, then drops to each agent at 16.7%, 50%,
             83.3% (3-col grid centers). Looks organic, not a stiff right
             angle. */}
        <div className="tree-branch tree-branch--leo" style={setDelay(1080)}>
          <svg
            viewBox="0 0 600 110"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d="M150 0 C 150 35, 100 50, 100 110"
              className="tree-line-path"
              pathLength={1}
            />
            <path
              d="M150 0 C 150 35, 300 50, 300 110"
              className="tree-line-path"
              pathLength={1}
            />
            <path
              d="M150 0 C 150 35, 500 50, 500 110"
              className="tree-line-path"
              pathLength={1}
            />
          </svg>
          <span className="tree-branch-pulse tree-branch-pulse--a" />
          <span className="tree-branch-pulse tree-branch-pulse--b" />
          <span className="tree-branch-pulse tree-branch-pulse--c" />
        </div>

        {/* ─── AGENT TIER (full width, 3 columns) ─── */}
        <div className="tree-tier tree-tier--agents">
            <article className="tree-node tree-node--agent" style={setDelay(1380)}>
              <span className="tree-node-eyebrow">// agent</span>
              <h3 className="tree-node-name">trader<em>.leo.looooo.eth</em></h3>
              <ul className="tree-perm-list">
                <li>
                  <span>target</span>
                  <code>Polymarket</code>
                </li>
                <li>
                  <span>cap</span>
                  <code>100 USDC / day</code>
                </li>
                <li>
                  <span>expires</span>
                  <code>7d</code>
                </li>
              </ul>
              <span className="tree-node-status tree-node-status--active">
                <span className="tree-node-status-dot" /> active
              </span>
            </article>

            <article className="tree-node tree-node--agent" style={setDelay(1500)}>
              <span className="tree-node-eyebrow">// agent</span>
              <h3 className="tree-node-name">dca<em>.leo.looooo.eth</em></h3>
              <ul className="tree-perm-list">
                <li>
                  <span>target</span>
                  <code>* any</code>
                </li>
                <li>
                  <span>cap</span>
                  <code>50 USDC / day</code>
                </li>
                <li>
                  <span>expires</span>
                  <code>30d</code>
                </li>
              </ul>
              <span className="tree-node-status tree-node-status--active">
                <span className="tree-node-status-dot" /> active
              </span>
            </article>

            <article className="tree-node tree-node--agent" style={setDelay(1620)}>
              <span className="tree-node-eyebrow">// agent</span>
              <h3 className="tree-node-name">swap<em>.leo.looooo.eth</em></h3>
              <ul className="tree-perm-list">
                <li>
                  <span>target</span>
                  <code>Uniswap</code>
                </li>
                <li>
                  <span>cap</span>
                  <code>25 USDC / day</code>
                </li>
                <li>
                  <span>expires</span>
                  <code>14d</code>
                </li>
              </ul>
              <span className="tree-node-status tree-node-status--active">
                <span className="tree-node-status-dot" /> active
              </span>
            </article>
        </div>
      </div>

      <p className="tree-foot mono">
        revoke a subname → revokes every leaf below it · ens hierarchy enforces it
      </p>
    </section>
  );
}
