"use client";

import { useEffect, useState } from "react";
import "./design.css";

/**
 * Design direction preview — not wired to chain state.
 *
 * Exists so the new system can be judged before it replaces working surfaces.
 * Everything here is real CSS from design.css; rolling it into /, /dashboard,
 * /agents and /recovery is a markup swap, not a rewrite.
 */

const NAME = "leo.ensign.eth";
const ADDR = "0xa742…f3d7";
const GLYPHS = "abcdef0123456789.·";

/**
 * The signature: the name resolving into the address it derives from. Reads
 * the product's whole thesis in one glance — the address comes FROM the name,
 * not the other way around.
 */
function Morph() {
  const [text, setText] = useState(NAME);
  const [showingName, setShowingName] = useState(true);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let timer = 0;

    const run = (from: string, to: string, done: () => void) => {
      const len = Math.max(from.length, to.length);
      let frame = 0;
      const step = () => {
        // Each character locks in after its own delay, left to right, so the
        // string appears to "resolve" rather than simply crossfade.
        const out = Array.from({ length: len }, (_, i) => {
          const settle = i * 1.6;
          if (frame > settle + 8) return to[i] ?? "";
          if (frame > settle) return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
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
      const [from, to] = showingName ? [NAME, ADDR] : [ADDR, NAME];
      run(from, to, () => {
        timer = window.setTimeout(() => setShowingName((s) => !s), 2100);
      });
    };
    timer = window.setTimeout(cycle, showingName ? 2100 : 0);

    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [showingName]);

  return <span className="ds-morph">{text}</span>;
}

export default function DesignPreview() {
  const rise = (d: number) => ({ animationDelay: `${d}ms` });

  return (
    <div className="ds">
      <nav className="ds-nav">
        <div className="ds-nav-in">
          <div className="ds-brand">ENSign <span>ENS v2</span></div>
          <div className="ds-navlinks">
            <a className="ds-navlink" href="#">Wallet</a>
            <a className="ds-navlink" href="#">Agents</a>
            <a className="ds-navlink" href="#">Recovery</a>
            <a className="ds-navlink" href="#">Docs</a>
          </div>
          <div className="ds-nav-right">
            <a className="ds-navlink" href="#">Sign in</a>
            <a className="ds-btn" href="#">Claim a name</a>
          </div>
        </div>
      </nav>

      {/* ── hero ── */}
      <section className="ds-wrap ds-hero">
        <h1 className="ds-h1 ds-rise" style={rise(40)}>
          Your name<br />is the wallet.
        </h1>
        <p className="ds-lede ds-rise" style={rise(140)}>
          Pick a subname, approve with your face, and one transaction later you have a
          passkey-controlled account at an address derived from the name itself.
          No seed phrase, no extension, no gas.
        </p>
        <div className="ds-rise" style={{ ...rise(220), marginTop: 30, fontSize: 26 }}>
          <Morph />
        </div>
        <div className="ds-hero-cta ds-rise" style={rise(300)}>
          <a className="ds-btn" href="#">Claim your name →</a>
          <a className="ds-btn ds-btn--ghost" href="#">See it resolve</a>
        </div>
        <p className="ds-hero-note ds-rise" style={rise(360)}>
          Live on Sepolia · <b>ENS v2 staging</b> · gas sponsored
        </p>

        {/* product slab */}
        <div className="ds-slab ds-rise" style={{ ...rise(430), textAlign: "left" }}>
          <div className="ds-slab-bar">
            <span className="ds-tab ds-tab--on">Overview</span>
            <span className="ds-tab">Agents</span>
            <span className="ds-tab">Recovery</span>
            <span className="ds-tab">Sign-in</span>
            <span className="ds-live"><i className="ds-dot" /> resolved 12s ago</span>
          </div>

          <div className="ds-stats">
            <div className="ds-stat">
              <div className="ds-stat-k">Name</div>
              <div className="ds-stat-v" style={{ fontSize: 20, fontFamily: "var(--font-mono)" }}>
                leo.ensign.eth
              </div>
              <div className="ds-stat-d">registered · 364d left</div>
            </div>
            <div className="ds-stat">
              <div className="ds-stat-k">Balance</div>
              <div className="ds-stat-v">1.284 ETH</div>
              <div className="ds-stat-d">+0.12 this week</div>
            </div>
            <div className="ds-stat">
              <div className="ds-stat-k">Agents</div>
              <div className="ds-stat-v">3</div>
              <div className="ds-stat-d">2 active · 1 expired</div>
            </div>
            <div className="ds-stat">
              <div className="ds-stat-k">Recovery</div>
              <div className="ds-stat-v">2 of 3</div>
              <div className="ds-stat-d">threshold met</div>
            </div>
          </div>

          <div className="ds-panels">
            <div className="ds-panel">
              <div className="ds-panel-h"><b>Name tree</b><span>ENS v2 · Sepolia</span></div>
              <div className="ds-tree">
                <div className="ds-node ds-node--root">
                  leo.ensign.eth
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
                <div className="ds-node ds-node--child" style={{ marginLeft: 52, opacity: .75 }}>
                  mom<span className="ds-node-tag">ens name</span>
                </div>
                <div className="ds-node ds-node--child" style={{ marginLeft: 52, opacity: .75 }}>
                  email<span className="ds-node-tag">zkemail</span>
                </div>
              </div>
            </div>

            <div className="ds-panel">
              <div className="ds-panel-h"><b>Records</b><span>on-chain</span></div>
              <div className="ds-rows">
                <div className="ds-row"><span>addr</span><b>0xa742…f3d7</b></div>
                <div className="ds-row"><span>credentialId</span><b>tKq9…8Vu</b></div>
                <div className="ds-row"><span>resolver</span><b>0x94B3…8a4D</b></div>
                <div className="ds-row"><span>registry</span><b>0x674c…fE06</b></div>
                <div className="ds-row"><span>token</span><b>#8095…3648</b></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── proof strip ── */}
      <div className="ds-wrap">
        <div className="ds-proof">
          <div className="ds-proof-lead">
            Every load-bearing piece of state is <em>on-chain ENS data</em>.
          </div>
          <div>
            <div className="ds-proof-k">Contracts live</div>
            <div className="ds-proof-v">7</div>
            <div className="ds-proof-s">Sepolia, verified</div>
          </div>
          <div>
            <div className="ds-proof-k">Off-chain database</div>
            <div className="ds-proof-v">None</div>
            <div className="ds-proof-s">Records resolve from ENS</div>
          </div>
          <div>
            <div className="ds-proof-k">Seed phrases</div>
            <div className="ds-proof-v">Zero</div>
            <div className="ds-proof-s">Passkey only</div>
          </div>
        </div>
      </div>

      {/* ── the inversion ── */}
      <section className="ds-band">
        <div className="ds-wrap ds-split">
          <div>
            <p className="ds-eyebrow">The inversion</p>
            <h2 className="ds-h2">The address derives from the name, not the other way around.</h2>
            <p className="ds-lede">
              Today every wallet starts as a hash, and the name gets bolted on later as
              a label pointing back at it. DNS solved this in 1983. ENSign makes the
              name the foundation: the account address is a pure function of it.
            </p>
            <div className="ds-speclist">
              <div className="ds-spec"><span className="ds-spec-k">Account address</span><span className="ds-spec-v">f(name)</span></div>
              <div className="ds-spec"><span className="ds-spec-k">Signing key</span><span className="ds-spec-v">passkey in resolver</span></div>
              <div className="ds-spec"><span className="ds-spec-k">Delegation</span><span className="ds-spec-v">a child subname</span></div>
              <div className="ds-spec"><span className="ds-spec-k">Revocation</span><span className="ds-spec-v">burn the parent</span></div>
            </div>
          </div>
          <div className="ds-slab" style={{ marginTop: 0 }}>
            <div className="ds-panel" style={{ minHeight: 300 }}>
              <div className="ds-panel-h"><b>Resolution</b><span>no CCIP · direct walk</span></div>
              <div className="ds-rows">
                <div className="ds-row"><span>.eth root</span><b>0xDEDB…8B67</b></div>
                <div className="ds-row"><span>↳ ensign</span><b>0x674c…fE06</b></div>
                <div className="ds-row"><span>↳ leo</span><b>resolver 0x94B3…8a4D</b></div>
                <div className="ds-row"><span>↳ addr(60)</span><b style={{ color: "var(--phosphor)" }}>0xa742…f3d7</b></div>
              </div>
              <p style={{ marginTop: 22, fontSize: 13, lineHeight: 1.6, color: "var(--on-forest-soft)" }}>
                Four hops, all on-chain. The wallet address falls out of the last one.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── capabilities ── */}
      <section className="ds-band ds-band--forest">
        <div className="ds-wrap">
          <p className="ds-eyebrow">Capabilities</p>
          <h2 className="ds-h2" style={{ maxWidth: "20ch" }}>
            Delegate and recover by name.
          </h2>
          <p className="ds-lede">
            Agents and guardians are subnames under yours. The ENS hierarchy is the
            capability tree — not metadata describing one.
          </p>

          <div className="ds-cards">
            <div className="ds-card">
              <div className="ds-card-top">
                <div className="ds-card-ic">⌘</div>
                <span className="ds-card-pill">live</span>
              </div>
              <h4>Agents as subnames</h4>
              <p>
                Grant <code>trader.leo.ensign.eth</code> permission to call transfer on
                USDC, capped at 10 a day, expiring in a week. Validated on-chain before
                anything forwards.
              </p>
            </div>
            <div className="ds-card">
              <div className="ds-card-top">
                <div className="ds-card-ic">◇</div>
                <span className="ds-card-pill">live</span>
              </div>
              <h4>Recovery as a namespace</h4>
              <p>
                Guardians are names, not addresses — so a guardian who rotates wallets
                keeps working. Let a name expire and it drops out of the quorum by
                itself.
              </p>
            </div>
            <div className="ds-card">
              <div className="ds-card-top">
                <div className="ds-card-ic">↗</div>
                <span className="ds-card-pill">live</span>
              </div>
              <h4>Sign in anywhere</h4>
              <p>
                A bookmarklet injects an EIP-1193 provider into any page. Aave, Uniswap,
                anything calling <code>window.ethereum</code> sees a real signer.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── close ── */}
      <section className="ds-band ds-band--paper">
        <div className="ds-wrap" style={{ textAlign: "center" }}>
          <h2 className="ds-h2" style={{ maxWidth: "18ch", margin: "0 auto 18px" }}>
            Take a name. Get a wallet.
          </h2>
          <p className="ds-lede" style={{ margin: "0 auto" }}>
            One transaction, sponsored. Nothing to install.
          </p>
          <div className="ds-hero-cta">
            <a className="ds-btn" href="#">Claim your name →</a>
          </div>
        </div>
      </section>

      <div className="ds-wrap">
        <footer className="ds-foot">
          <span>ENSign · ENS v2 on Sepolia</span>
          <span className="ds-foot-sp">
            <a href="#">Pitch</a><a href="#">GitHub</a><a href="#">Explorer</a>
          </span>
        </footer>
      </div>
    </div>
  );
}
