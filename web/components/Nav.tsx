"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearSession, getSession } from "@/lib/session";
import { PARENT_NAME } from "@/lib/ensign";
import { useEffect, useRef, useState } from "react";
import "../app/system.css";

/// Signed-in surfaces. `send` was removed — a generic transfer form isn't the
/// product, and it crowded out recovery, which had no route into it at all.
const TABS = [
  { href: "/dashboard", label: "Wallet" },
  { href: "/agents", label: "Agents" },
  { href: "/recovery", label: "Recovery" },
  { href: "/install", label: "Sign-in" },
] as const;

export function Nav({ onClaim }: { onClaim?: () => void } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const [label, setLabel] = useState<string | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const s = getSession();
    setLabel(s?.label ?? null);
    setAccount(s?.account ?? null);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function disconnect() {
    clearSession();
    setLabel(null);
    setAccount(null);
    setOpen(false);
    router.push("/");
  }

  async function copyAddress() {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — nothing useful to do */ }
  }

  /// Signed out and off the landing page there is no modal to open here, so
  /// route home, where the claim / sign-in flow lives.
  const connect = onClaim ?? (() => router.push("/"));

  const fullName = label ? `${label}.${PARENT_NAME}` : "";

  return (
    <nav className="ds-nav">
      <div className="ds-nav-in">
        <Link
          href={label ? "/dashboard" : "/"}
          className="ds-brand"
          style={{ textDecoration: "none" }}
        >
          ENSign <span>ENS v2</span>
        </Link>

        {label && (
          <div className="ds-navlinks">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="ds-navlink"
                style={pathname === t.href ? { color: "var(--on-paper)", fontWeight: 500 } : undefined}
              >
                {t.label}
              </Link>
            ))}
          </div>
        )}

        <div className="ds-nav-right">
          {!label ? (
            <>
              <Link href="/pitch" className="ds-navlink">Pitch</Link>
              <a
                className="ds-navlink"
                href="https://github.com/LeoFranklin015/ENSign"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
              {/* One button covers both paths — the flow detects whether the
                  name is already minted and switches to sign-in itself. */}
              <button
                className="ds-btn"
                onClick={connect}
                style={{ padding: "11px 20px", fontSize: 14 }}
              >
                Connect
              </button>
            </>
          ) : (
            <div className="ds-account" ref={popRef}>
              <button
                type="button"
                className="ds-account-btn"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-haspopup="menu"
                title={fullName}
              >
                <i />
                {label}
                <span className="ds-account-suffix">.{PARENT_NAME}</span>
                <span className="ds-account-caret" aria-hidden>▾</span>
              </button>

              {open && (
                <div className="ds-pop" role="menu">
                  <div className="ds-pop-head">
                    <div className="ds-pop-name">{fullName}</div>
                    {account && (
                      <div className="ds-pop-addr">
                        {account.slice(0, 12)}…{account.slice(-10)}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className="ds-pop-item"
                    onClick={copyAddress}
                    disabled={!account}
                  >
                    <span>{copied ? "Address copied" : "Copy address"}</span>
                    <span className="ds-pop-hint">{copied ? "✓" : "⧉"}</span>
                  </button>

                  <Link href="/dashboard" className="ds-pop-item" onClick={() => setOpen(false)}>
                    <span>Wallet</span>
                    <span className="ds-pop-hint">→</span>
                  </Link>
                  <Link href="/recovery" className="ds-pop-item" onClick={() => setOpen(false)}>
                    <span>Recovery</span>
                    <span className="ds-pop-hint">→</span>
                  </Link>

                  <div className="ds-pop-rule" />

                  <a
                    className="ds-pop-item"
                    href={`https://explorer.ens.dev/${fullName}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpen(false)}
                  >
                    <span>ENS explorer</span>
                    <span className="ds-pop-hint">↗</span>
                  </a>
                  {account && (
                    <a
                      className="ds-pop-item"
                      href={`https://sepolia.etherscan.io/address/${account}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setOpen(false)}
                    >
                      <span>Etherscan</span>
                      <span className="ds-pop-hint">↗</span>
                    </a>
                  )}

                  <div className="ds-pop-rule" />

                  <button
                    type="button"
                    className="ds-pop-item ds-pop-item--danger"
                    onClick={disconnect}
                  >
                    <span>Disconnect</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
