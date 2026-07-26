"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import "../app/system.css";
import { getSession } from "@/lib/session";
import { Nav } from "@/components/Nav";
import { BookmarkletCard } from "@/components/BookmarkletCard";
import { PARENT_NAME } from "@/lib/ensign";

export default function InstallContent() {
  const router = useRouter();
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace("/");
      return;
    }
    setLabel(s.label);
  }, [router]);

  if (!label) {
    return (
      <div className="ds ds-page">
        <Nav />
        <main className="ds-wrap ds-app"><p className="ds-lede">Redirecting…</p></main>
      </div>
    );
  }

  const fullName = `${label}.${PARENT_NAME}`;

  return (
    <div className="ds ds-page">
      <Nav />

      <main className="ds-wrap ds-app">
        <header className="ds-idcard">
          <div>
            <h1 className="ds-idcard-name">Sign-in</h1>
            <p className="ds-idcard-addr">
              use {fullName} on any dApp · nothing to install
            </p>
          </div>
        </header>

        <div className="ds-install">
          {/* the whole page exists for this one gesture */}
          <section className="ds-drag">
            <p className="ds-drag-k">Drag me to your bookmarks bar</p>
            <BookmarkletCard />
            <p className="ds-drag-hint">
              It carries the connector inside the link itself, so it keeps working on
              pages whose security policy blocks outside scripts.
            </p>
          </section>

          <section>
            <ol className="ds-steps">
              <li>
                <b>01</b>
                <span>Drag the button onto your bookmarks bar.</span>
              </li>
              <li>
                <b>02</b>
                <span>Open any Sepolia dApp — Aave, Uniswap, anything — and click it.</span>
              </li>
              <li>
                <b>03</b>
                <span>
                  The page sees a real EIP-1193 signer. Approve with your passkey and it
                  signs as <em>{fullName}</em>.
                </span>
              </li>
            </ol>

            <div className="ds-stat-card" style={{ marginTop: 14 }}>
              <p className="ds-stat-k">What the dApp sees</p>
              <div className="ds-recs">
                <div className="ds-rec"><span>provider</span><b>window.ethereum</b></div>
                <div className="ds-rec"><span>account</span><b>{fullName}</b></div>
                <div className="ds-rec"><span>signing</span><b>passkey · ERC-4337</b></div>
                <div className="ds-rec"><span>gas</span><b style={{ color: "var(--data)" }}>sponsored</b></div>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="ds-footer">
        <div className="ds-footer-in">
          <span className="ds-footer-who"><i /> Signed in as <b>{fullName}</b></span>
          <span className="ds-footer-links">
            <Link href="/dashboard">Wallet</Link>
            <Link href="/agents">Agents</Link>
            <Link href="/recovery">Recovery</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
