"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import "../app/app.css";
import { PARENT_NAME, publicClient, resolveLabel } from "@/lib/ensign";
import { getSession, type Session } from "@/lib/session";
import { Nav } from "@/components/Nav";

export default function DashboardContent() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace("/");
      return;
    }
    setSession(s);
    (async () => {
      try {
        const r = await resolveLabel(s.label);
        setAccount(r.account);
        const b = await publicClient.getBalance({ address: r.account });
        setBalance(b);
      } catch {
        // name not resolvable — likely deleted; redirect
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  if (!session) {
    return (
      <div className="app-shell">
        <Nav />
        <main className="main"><p className="hero-sub">redirecting…</p></main>
      </div>
    );
  }

  const fullName = `${session.label}.${PARENT_NAME}`;

  return (
    <div className="app-shell">
      <Nav />

      <main className="main">
        <section className="dash-hero">
          <p className="kicker">welcome back</p>
          <h1 className="hero-title">
            {session.label}<em style={{ color: "var(--text-muted)" }}>.{PARENT_NAME}</em>
          </h1>
        </section>

        <div className="card-grid">
          <article className="card">
            <p className="card-label">smart account</p>
            <p className="card-value mono">
              {account ? (
                <a
                  href={`https://sepolia.etherscan.io/address/${account}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {account.slice(0, 10)}…{account.slice(-6)}
                </a>
              ) : loading ? (
                "…"
              ) : (
                "not resolvable"
              )}
            </p>
            <p className="card-meta">passkey-controlled · ERC-4337 v0.8</p>
          </article>

          <article className="card card-balance">
            <p className="card-label">balance</p>
            <p className="card-value-big">
              {balance === null ? (
                "—"
              ) : (
                <>
                  <span className="balance-num">{formatEth(balance)}</span>
                  <span className="balance-unit">ETH</span>
                </>
              )}
            </p>
            <p className="card-meta">sepolia testnet</p>
          </article>

          <article className="card card-name">
            <p className="card-label">ens name</p>
            <p className="card-value">
              <a
                href={`https://explorer.ens.dev/${fullName}`}
                target="_blank"
                rel="noreferrer"
              >
                {fullName}
              </a>
            </p>
            <p className="card-meta">
              addr(node) · text("credentialId")
            </p>
          </article>
        </div>

        <section className="actions-row">
          <Link href="/send" className="action-link">
            <div className="action-link-body">
              <p className="action-link-title">send a transaction</p>
              <p className="action-link-sub">
                build & sign by name. uses your passkey · relayed via EntryPoint.
              </p>
            </div>
            <span className="action-link-arrow">→</span>
          </Link>

          <Link href="/install" className="action-link">
            <div className="action-link-body">
              <p className="action-link-title">use ENSign on any dApp</p>
              <p className="action-link-sub">
                drag the bookmarklet, click on Aave / Uniswap testnet.
              </p>
            </div>
            <span className="action-link-arrow">→</span>
          </Link>
        </section>
      </main>

      <footer className="foot">
        <span className="brand-name">
          EN<em style={{ color: "var(--acc)", fontStyle: "normal" }}>S</em>ign
        </span>
        <span>signed in as <span style={{ color: "var(--text-soft)" }}>{fullName}</span></span>
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

function formatEth(wei: bigint): string {
  if (wei === 0n) return "0";
  const eth = Number(wei) / 1e18;
  if (eth < 0.0001) return eth.toExponential(2);
  if (eth < 1) return eth.toFixed(6).replace(/\.?0+$/, "");
  return eth.toFixed(4).replace(/\.?0+$/, "");
}
