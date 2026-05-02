"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearSession, getSession } from "@/lib/session";
import { PARENT_NAME, REGISTRY } from "@/lib/ensign";
import { useEffect, useState } from "react";

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const s = getSession();
    setLabel(s?.label ?? null);
  }, []);

  function logout() {
    clearSession();
    router.push("/");
  }

  const tabs = [
    { href: "/dashboard", label: "home" },
    { href: "/send", label: "send" },
    { href: "/install", label: "install" },
  ] as const;

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
        {label ? (
          <>
            <span className="bar-name">
              <span className="bar-name-dot" aria-hidden="true" />
              <span>
                {label}
                <span className="bar-name-suffix">.{PARENT_NAME}</span>
              </span>
            </span>
            <button className="bar-link" onClick={logout}>
              logout
            </button>
          </>
        ) : (
          <a
            href={`https://sepolia.etherscan.io/address/${REGISTRY}`}
            target="_blank"
            rel="noreferrer"
            title="ENSign registry"
          >
            {REGISTRY.slice(0, 6)}…{REGISTRY.slice(-4)}
          </a>
        )}
      </div>
    </header>
  );
}
