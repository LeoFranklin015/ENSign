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
        </section>

        <div className="form-card">
          <BookmarkletCard />

          <ol className="steps install-steps">
            <li>
              <span className="step-num">01</span>
              <span>drag the lime button to your bookmarks bar</span>
            </li>
            <li>
              <span className="step-num">02</span>
              <span>open any sepolia dApp · click the bookmark</span>
            </li>
            <li>
              <span className="step-num">03</span>
              <span>sign as <em>{label}</em> with your passkey</span>
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
