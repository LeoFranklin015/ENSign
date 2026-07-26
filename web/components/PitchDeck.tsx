"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import "../app/system.css";

/**
 * Four slides. One idea each.
 *
 * Deliberately short: agents, the permission model and the ENSv2 wiring were
 * cut. A deck's job is to make one thing land, and the thing here is that the
 * name comes first and everything — including getting back in — hangs off it.
 */

const SLIDES = [
  { id: "cover", label: "ENSign" },
  { id: "what", label: "the idea" },
  { id: "recovery", label: "recovery" },
  { id: "quorum", label: "m of n" },
  { id: "live", label: "live" },
] as const;

const d = (ms: number): CSSProperties => ({ ["--d" as never]: `${ms}ms` } as CSSProperties);

export default function PitchDeck() {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          const i = refs.current.findIndex((r) => r === e.target);
          if (i < 0) return;
          if (e.intersectionRatio >= 0.5) {
            setActive(i);
            (e.target as HTMLElement).classList.add("is-in");
          }
        });
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    refs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const setRef = (i: number) => (el: HTMLElement | null) => { refs.current[i] = el; };

  return (
    <div className="ds ds-deck">
      <header className="ds-deckbar">
        <Link href="/" className="ds-deckbar-brand">ENSign</Link>
        <span className="ds-deckbar-meta">
          {String(active + 1).padStart(2, "0")} / {String(SLIDES.length).padStart(2, "0")} ·{" "}
          {SLIDES[active].label}
        </span>
        <div
          className="ds-deckbar-prog"
          style={{ width: `${((active + 1) / SLIDES.length) * 100}%` }}
          aria-hidden
        />
      </header>

      {/* ── 01 · the claim ── */}
      <section ref={setRef(0)} className="ds-slide is-in">
        <div className="ds-slide-in" style={{ textAlign: "center" }}>
          <p className="ds-slide-eyebrow" data-r style={d(0)}>ENS v2 · Sepolia</p>
          <h1 className="ds-slide-h" data-r style={d(120)}>
            Your name<br />is the <em>wallet</em>.
          </h1>
          <p className="ds-slide-sub" data-r style={{ ...d(280), margin: "24px auto 0" }}>
            Pick an ENS subname and you have a self-custodial account at an address derived
            from that name. No seed phrase, no extension, no gas.
          </p>
          <p
            className="ds-slide-eyebrow"
            data-r
            style={{ ...d(420), marginTop: 34, marginBottom: 0 }}
          >
            scroll ↓
          </p>
        </div>
      </section>

      {/* ── 02 · what it is ── */}
      <section ref={setRef(1)} className="ds-slide">
        <div className="ds-slide-in">
          <div className="ds-deck-cols">
            <div>
              <p className="ds-slide-eyebrow" data-r style={d(0)}>The idea</p>
              <h2 className="ds-slide-h" data-r style={d(120)}>
                The address comes <em>from</em> the name.
              </h2>
              <p className="ds-slide-sub" data-r style={d(240)}>
                Every wallet today starts as a hash, and a name gets bolted on afterwards as a
                label pointing back at it. ENS v2 lets us invert that: the name is the record,
                and the account falls out of it.
              </p>
            </div>

            <div className="ds-slab" data-r style={d(360)}>
              <div className="ds-slab-bar">
                <span className="ds-tab ds-tab--on">leo.ensign.eth</span>
                <span className="ds-live"><i className="ds-dot" /> on-chain</span>
              </div>
              <div className="ds-panel">
                <div className="ds-rows">
                  <div className="ds-row"><span>addr(node)</span><b>0xa742…f3d7</b></div>
                  <div className="ds-row"><span>text(credentialId)</span><b>your passkey</b></div>
                  <div className="ds-row"><span>owner</span><b>the account itself</b></div>
                </div>
                <p style={{ marginTop: 18, fontSize: 13, lineHeight: 1.6, color: "var(--on-dark-soft)" }}>
                  The passkey that signs lives in the name&apos;s resolver. There is no database
                  behind this — every field is ENS state.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 03 · recovery ── */}
      <section ref={setRef(2)} className="ds-slide">
        <div className="ds-slide-in">
          <div className="ds-deck-cols">
            <div>
              <p className="ds-slide-eyebrow" data-r style={d(0)}>Recovery</p>
              <h2 className="ds-slide-h" data-r style={d(120)}>
                Your guardian is a <em>name</em>.
              </h2>
              <p className="ds-slide-sub" data-r style={d(240)}>
                A passkey wallet has nothing to write down. That is the point, and the risk.
                So add your mom as a guardian and she becomes a subname under yours,
                mom.recovery.leo.ensign.eth — a real ENS record, not a row in our database.
              </p>
              <p className="ds-slide-sub" data-r style={{ ...d(320), marginTop: 16 }}>
                She does not need a wallet. Add her email and she approves by hitting reply;
                zkEmail proves it was her without her address ever touching the chain.
              </p>
            </div>

            <div data-r style={d(420)}>
              <div className="ds-tree">
                <div className="ds-tree-row">
                  <span className="ds-tree-k">leo.ensign.eth</span>
                  <span className="ds-tree-tag">the wallet</span>
                </div>
                <div className="ds-tree-row ds-tree-l1">
                  <span className="ds-tree-branch">└─</span>
                  <span className="ds-tree-k">recovery</span>
                  <span className="ds-tree-tag">guardian namespace</span>
                </div>
                <div className="ds-tree-row ds-tree-l2 ds-tree-row--g">
                  <span className="ds-tree-branch">├─</span>
                  <span className="ds-tree-k">mom</span>
                  <span className="ds-tree-tag">wallet · signs</span>
                </div>
                <div className="ds-tree-row ds-tree-l2 ds-tree-row--g">
                  <span className="ds-tree-branch">├─</span>
                  <span className="ds-tree-k">dad</span>
                  <span className="ds-tree-tag">email · zkEmail</span>
                </div>
                <div className="ds-tree-row ds-tree-l2 ds-tree-row--g">
                  <span className="ds-tree-branch">└─</span>
                  <span className="ds-tree-k">safe</span>
                  <span className="ds-tree-tag">multisig · ERC-1271</span>
                </div>
              </div>
              <p style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6, color: "var(--on-paper-soft)" }}>
                Because mom is a <em>name</em>, she can move to a new wallet and stay your
                guardian. A name that expires drops out of the quorum by itself.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 04 · M-of-N ── */}
      <section ref={setRef(3)} className="ds-slide">
        <div className="ds-slide-in">
          <div className="ds-deck-cols">
            <div>
              <p className="ds-slide-eyebrow" data-r style={d(0)}>M of N</p>
              <h2 className="ds-slide-h" data-r style={d(120)}>
                Two of three, then a <em>pause</em>.
              </h2>
              <p className="ds-slide-sub" data-r style={d(240)}>
                You choose how many guardians have to agree. The manager verifies each approval
                on-chain, counts them against your threshold, and queues the change behind a
                timelock you can cancel.
              </p>

              <div className="ds-tree" data-r style={{ ...d(340), marginTop: 22 }}>
                <div className="ds-tree-row">
                  <span className="ds-tree-k">ENSignRecoveryManager</span>
                  <span className="ds-tree-tag">holds no proof logic</span>
                </div>
                <div className="ds-tree-row ds-tree-l1 ds-tree-row--g">
                  <span className="ds-tree-branch">├─</span>
                  <span className="ds-tree-k">ENSRecoveryProvider</span>
                  <span className="ds-tree-tag">a name</span>
                </div>
                <div className="ds-tree-row ds-tree-l1 ds-tree-row--g">
                  <span className="ds-tree-branch">├─</span>
                  <span className="ds-tree-k">ZkEmailRecoveryProvider</span>
                  <span className="ds-tree-tag">an email</span>
                </div>
                <div className="ds-tree-row ds-tree-l1 ds-tree-row--g">
                  <span className="ds-tree-branch">└─</span>
                  <span className="ds-tree-k">ECDSARecoveryProvider</span>
                  <span className="ds-tree-tag">a backup key</span>
                </div>
                <div className="ds-quorum" style={{ marginTop: 18 }}>
                  <i className="on" /><i className="on" /><i />
                  <b>2 of 3 — threshold met</b>
                </div>
              </div>
              <p style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6, color: "var(--on-paper-soft)" }}>
                A new way to recover is a new provider contract, not a migration.
              </p>
            </div>

            <div className="ds-flow">
              <div className="ds-flow-step" data-r style={d(420)}>
                <div className="ds-flow-n">01</div>
                <div>
                  <b>Anyone opens your link</b>
                  <span>
                    The recovery page is public and keyed by your name. You have lost your
                    device — you do not need to be there.
                  </span>
                </div>
              </div>
              <div className="ds-flow-step" data-r style={d(500)}>
                <div className="ds-flow-n">02</div>
                <div>
                  <b>Guardians approve</b>
                  <span>
                    Mom signs, or replies to an email. Each proof is bound to your account and
                    its nonce, so it authorises exactly one recovery.
                  </span>
                </div>
              </div>
              <div className="ds-flow-step" data-r style={d(580)}>
                <div className="ds-flow-n">03</div>
                <div>
                  <b>Threshold met, clock starts</b>
                  <span>
                    The request waits out the longest delay any approving guardian set — so one
                    cautious guardian cannot be routed around.
                  </span>
                </div>
              </div>
              <div className="ds-flow-step ds-flow-step--veto" data-r style={d(660)}>
                <div className="ds-flow-n">04</div>
                <div>
                  <b>You can cancel</b>
                  <span>
                    If it was not you, veto it while it waits. Only the account can.
                  </span>
                </div>
              </div>
              <div className="ds-flow-step" data-r style={d(740)}>
                <div className="ds-flow-n">05</div>
                <div>
                  <b>A new passkey goes in</b>
                  <span>
                    The only thing recovery can ever do. It cannot move funds, remove you, or
                    change your threshold.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 05 · live ── */}
      <section ref={setRef(4)} className="ds-slide">
        <div className="ds-slide-in" style={{ textAlign: "center" }}>
          <p className="ds-slide-eyebrow" data-r style={d(0)}>Working today</p>
          <h2 className="ds-slide-h" data-r style={d(120)}>
            Live on Sepolia.
          </h2>

          <dl className="ds-deck-kv">
            <div data-r style={d(280)}>
              <dt>Name → wallet</dt>
              <dd>1 tx<small>sponsored, passkey-signed</small></dd>
            </div>
            <div data-r style={d(360)}>
              <dt>Recovery</dt>
              <dd>M-of-N<small>wallet or email guardians</small></dd>
            </div>
            <div data-r style={d(440)}>
              <dt>Off-chain database</dt>
              <dd>None<small>records resolve from ENS</small></dd>
            </div>
          </dl>

          <p className="ds-slide-sub" data-r style={{ ...d(540), margin: "30px auto 0" }}>
            Built on ENS v2 staging, with a real zkEmail proof verified on-chain by a verifier
            we deployed to match our prover.
          </p>

          <div className="ds-hero-cta" data-r style={{ ...d(640), justifyContent: "center" }}>
            <Link className="ds-btn" href="/">Try it <span aria-hidden>→</span></Link>
            <a
              className="ds-btn ds-btn--ghost"
              href="https://github.com/LeoFranklin015/ENSign"
              target="_blank" rel="noreferrer"
            >
              GitHub ↗
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
