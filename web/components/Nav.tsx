"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearSession, getSession } from "@/lib/session";
import { PARENT_NAME } from "@/lib/ensign";
import { useEffect, useRef, useState } from "react";

export function Nav() {
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

  // Click-outside / escape close
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
    } catch {
      // ignore
    }
  }

  const tabs = [
    { href: "/dashboard", label: "home" },
    { href: "/send", label: "send" },
    { href: "/agents", label: "agents" },
    { href: "/install", label: "install" },
  ] as const;

  const fullName = label ? `${label}.${PARENT_NAME}` : "";

  return (
    <header className="bar">
      <Link href={label ? "/dashboard" : "/"} className="brand">
        <span className="brand-glyph" aria-hidden="true" />
        <span className="brand-name">
          EN<em>S</em>ign
        </span>
      </Link>

      {label ? (
        <nav className="nav-tabs">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`nav-tab${pathname === t.href ? " nav-tab--active" : ""}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      ) : (
        <span aria-hidden="true" />
      )}

      <div className="bar-right">
        {/* Pitch link — only on landing (no session). */}
        {!label && (
          <Link
            href="/pitch"
            className={`nav-pitch${pathname === "/pitch" ? " nav-pitch--active" : ""}`}
          >
            pitch ↗
          </Link>
        )}
        {label ? (
          <div className="nav-id" ref={popRef}>
            <button
              type="button"
              className={`bar-name bar-name--button${open ? " bar-name--open" : ""}`}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-haspopup="menu"
              title={fullName}
            >
              <span className="bar-name-dot" aria-hidden="true" />
              <span>
                {label}
                <span className="bar-name-suffix">.{PARENT_NAME}</span>
              </span>
              <span className="bar-name-caret" aria-hidden="true">
                ▾
              </span>
            </button>

            {open && (
              <div className="nav-pop" role="menu">
                <div className="nav-pop-head">
                  <span className="nav-pop-name">{fullName}</span>
                  {account && (
                    <span className="nav-pop-addr mono">
                      {account.slice(0, 6)}…{account.slice(-4)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="nav-pop-item"
                  onClick={copyAddress}
                  disabled={!account}
                >
                  <span>{copied ? "address copied" : "copy address"}</span>
                  <span className="nav-pop-shortcut mono">⌘C</span>
                </button>
                <a
                  className="nav-pop-item"
                  href={`https://explorer.ens.dev/${fullName}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                >
                  <span>view on ENS explorer</span>
                  <span className="nav-pop-shortcut">↗</span>
                </a>
                {account && (
                  <a
                    className="nav-pop-item"
                    href={`https://sepolia.etherscan.io/address/${account}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpen(false)}
                  >
                    <span>view on Etherscan</span>
                    <span className="nav-pop-shortcut">↗</span>
                  </a>
                )}
                <div className="nav-pop-divider" />
                <button
                  type="button"
                  className="nav-pop-item nav-pop-item--danger"
                  onClick={() => {
                    setOpen(false);
                    logout();
                  }}
                >
                  <span>log out</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
    </header>
  );
}
