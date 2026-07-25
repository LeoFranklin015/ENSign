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

  function logout() {
    clearSession();
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

  const fullName = label ? `${label}.${PARENT_NAME}` : "";

  return (
    <nav className="ds-nav">
      <div className="ds-nav-in">
        <Link href={label ? "/dashboard" : "/"} className="ds-brand" style={{ textDecoration: "none", color: "inherit" }}>
          ENSign <span>ENS v2</span>
        </Link>

        {label && (
          <div className="ds-navlinks">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="ds-navlink"
                style={
                  pathname === t.href
                    ? { color: "var(--on-paper)", fontWeight: 500 }
                    : undefined
                }
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
              {onClaim && (
                <button className="ds-btn" style={{ padding: "10px 18px", fontSize: 14 }} onClick={onClaim}>
                  Claim a name
                </button>
              )}
              <a
                className="ds-navlink"
                href="https://github.com/LeoFranklin015/ENSign"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </>
          ) : (
            <div ref={popRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="ds-btn ds-btn--ghost"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-haspopup="menu"
                title={fullName}
                style={{ fontFamily: "var(--font-mono)", fontSize: 13, padding: "9px 15px" }}
              >
                <i className="ds-dot" />
                {label}
                <span style={{ color: "var(--on-paper-faint)" }}>.{PARENT_NAME}</span>
              </button>

              {open && (
                <div
                  role="menu"
                  style={{
                    position: "absolute", right: 0, top: "calc(100% + 9px)",
                    minWidth: 264, padding: 7,
                    background: "var(--paper)",
                    border: "1px solid var(--rule)",
                    borderRadius: 13,
                    boxShadow: "0 22px 44px -20px rgba(15,43,34,.28)",
                    zIndex: 60,
                  }}
                >
                  <div style={{ padding: "9px 11px 11px", borderBottom: "1px solid var(--rule)", marginBottom: 5 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{fullName}</div>
                    {account && (
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--on-paper-faint)", marginTop: 4 }}>
                        {account.slice(0, 10)}…{account.slice(-8)}
                      </div>
                    )}
                  </div>
                  <PopItem onClick={copyAddress} disabled={!account}>
                    {copied ? "Address copied" : "Copy address"}
                  </PopItem>
                  <PopItem href={`https://explorer.ens.dev/${fullName}`} onClick={() => setOpen(false)}>
                    View on ENS explorer ↗
                  </PopItem>
                  {account && (
                    <PopItem
                      href={`https://sepolia.etherscan.io/address/${account}`}
                      onClick={() => setOpen(false)}
                    >
                      View on Etherscan ↗
                    </PopItem>
                  )}
                  <div style={{ height: 1, background: "var(--rule)", margin: "5px 0" }} />
                  <PopItem onClick={() => { setOpen(false); logout(); }} danger>
                    Log out
                  </PopItem>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

function PopItem({
  children, onClick, href, disabled, danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  const style: React.CSSProperties = {
    display: "block", width: "100%", textAlign: "left",
    padding: "9px 11px", borderRadius: 8, border: 0,
    background: "transparent", cursor: disabled ? "not-allowed" : "pointer",
    font: "400 13.5px/1.3 var(--font-body)",
    color: danger ? "#A34733" : "var(--on-paper-soft)",
    opacity: disabled ? 0.45 : 1,
    textDecoration: "none",
  };
  const hover = (e: React.MouseEvent<HTMLElement>, on: boolean) => {
    (e.currentTarget as HTMLElement).style.background = on ? "rgba(20,32,27,.05)" : "transparent";
  };
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" style={style} onClick={onClick}
         onMouseEnter={(e) => hover(e, true)} onMouseLeave={(e) => hover(e, false)}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" style={style} onClick={onClick} disabled={disabled}
            onMouseEnter={(e) => hover(e, true)} onMouseLeave={(e) => hover(e, false)}>
      {children}
    </button>
  );
}
