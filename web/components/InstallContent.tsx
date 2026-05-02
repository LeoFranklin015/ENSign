"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import "../app/app.css";
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
      <div className="app-shell">
        <Nav />
        <main className="main"><p className="hero-sub">redirecting…</p></main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Nav />

      <main className="main">
        <section className="hero compact">
          <p className="kicker">embed</p>
          <h1 className="hero-title-sm">
            wallet on <em>any</em> dApp.
          </h1>
          <p className="hero-sub">
            Drag the bookmarklet to your bookmarks bar. Click it on any dApp page —
            ENSign appears as <strong>window.ethereum</strong> via EIP-1193 + EIP-6963.
            No extension to install. Nothing for the dApp to integrate.
          </p>
        </section>

        <div className="form-card">
          <BookmarkletCard />

          <ol className="steps">
            <li>
              <span className="step-num">01</span>
              <span>drag the lime button into your bookmarks bar</span>
            </li>
            <li>
              <span className="step-num">02</span>
              <span>visit any dApp on sepolia (try aave, uniswap)</span>
            </li>
            <li>
              <span className="step-num">03</span>
              <span>click the bookmark — the ENSign iframe opens</span>
            </li>
            <li>
              <span className="step-num">04</span>
              <span>type <em>{label}</em> · sign with passkey · done</span>
            </li>
          </ol>
        </div>
      </main>

      <footer className="foot">
        <span className="brand-name">
          EN<em style={{ color: "var(--acc)", fontStyle: "normal" }}>S</em>ign
        </span>
        <span>embed surface · iframe + postMessage bridge</span>
      </footer>
    </div>
  );
}
