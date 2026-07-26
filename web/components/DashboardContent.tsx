"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { parseAbi, type Address } from "viem";
import "../app/system.css";
import {
  PARENT_NAME,
  publicClient,
  resolveLabel,
  getPrimaryName,
  setPrimaryNameData,
  sendUserOp,
  REVERSE_REGISTRAR,
} from "@/lib/ensign";
import { getSession, type Session } from "@/lib/session";
import { Nav } from "@/components/Nav";

const RECOVERY_MANAGER = (process.env.NEXT_PUBLIC_RECOVERY_MANAGER ??
  "0xD952928319e72c3F96eBD3e6398a8421f0865846") as Address;

const managerAbi = parseAbi([
  "function recoveryCount(address account) view returns (uint256)",
  "function recoveryThreshold(address account) view returns (uint256)",
]);

type PrimaryState =
  | { kind: "checking" }
  | { kind: "unset" }
  | { kind: "pending" }
  | { kind: "set"; name: string }
  | { kind: "error"; message: string };

export default function DashboardContent() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [recovery, setRecovery] = useState<{ count: number; threshold: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [primary, setPrimary] = useState<PrimaryState>({ kind: "checking" });
  const [primaryTx, setPrimaryTx] = useState<`0x${string}` | null>(null);

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

        // Independent reads: one failing shouldn't blank the others.
        const [p, b, rec] = await Promise.allSettled([
          getPrimaryName(r.account),
          publicClient.getBalance({ address: r.account }),
          Promise.all([
            publicClient.readContract({
              address: RECOVERY_MANAGER, abi: managerAbi,
              functionName: "recoveryCount", args: [r.account],
            }),
            publicClient.readContract({
              address: RECOVERY_MANAGER, abi: managerAbi,
              functionName: "recoveryThreshold", args: [r.account],
            }),
          ]),
        ]);

        if (p.status === "fulfilled") {
          setPrimary(p.value ? { kind: "set", name: p.value } : { kind: "unset" });
        } else {
          setPrimary({ kind: "unset" });
        }
        if (b.status === "fulfilled") setBalance(b.value);
        if (rec.status === "fulfilled") {
          setRecovery({ count: Number(rec.value[0]), threshold: Number(rec.value[1]) });
        }
      } catch {
        // name not resolvable — the nav still lets them sign out
      }
    })();
  }, [router]);

  async function onSetPrimary() {
    if (!session || !account) return;
    const name = `${session.label}.${PARENT_NAME}`;
    setPrimary({ kind: "pending" });
    try {
      const res = await sendUserOp({
        account,
        credentialId: session.credentialId,
        target: REVERSE_REGISTRAR,
        data: setPrimaryNameData(name),
      });
      if (!res.success) throw new Error("transaction reverted");
      setPrimaryTx(res.tx);
      const now = await getPrimaryName(account);
      setPrimary(now ? { kind: "set", name: now } : { kind: "unset" });
    } catch (e) {
      const raw = (e as Error)?.message ?? "failed";
      setPrimary({ kind: "error", message: raw.length > 90 ? raw.slice(0, 90) + "…" : raw });
    }
  }

  async function copyAddress() {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  if (!session) {
    return (
      <div className="ds ds-page">
        <Nav />
        <main className="ds-wrap ds-app">
          <p className="ds-lede">Redirecting…</p>
        </main>
      </div>
    );
  }

  const fullName = `${session.label}.${PARENT_NAME}`;
  const isPrimary = primary.kind === "set" && primary.name === fullName;
  const hasGuardians = !!recovery && recovery.count > 0;

  return (
    <div className="ds ds-page">
      <Nav />

      <main className="ds-wrap ds-app">
        {/* the name is the subject of this page, so it's the headline */}
        <header className="ds-idcard">
          <div>
            <h1 className="ds-idcard-name">
              {session.label}<span>.{PARENT_NAME}</span>
            </h1>
            <p className="ds-idcard-addr">
              {account ? (
                <a
                  href={`https://sepolia.etherscan.io/address/${account}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {account}
                </a>
              ) : (
                "resolving…"
              )}
            </p>
          </div>
          <div className="ds-idcard-actions">
            <button className="ds-btn ds-btn--ghost" onClick={copyAddress} disabled={!account}>
              {copied ? "Copied" : "Copy address"}
            </button>
            <a
              className="ds-btn ds-btn--ghost"
              href={`https://explorer.ens.dev/${fullName}`}
              target="_blank"
              rel="noreferrer"
            >
              ENS explorer ↗
            </a>
          </div>
        </header>

        {/* state, read at a glance — no dark slab, no trivia */}
        <div className="ds-strip">
          <div className="ds-strip-cell ds-strip-cell--lime ds-in">
            <p className="ds-strip-k">Balance</p>
            <p className="ds-strip-v">
              {balance === null ? "—" : formatEth(balance)}<small>ETH</small>
            </p>
            <p className="ds-strip-note">Sepolia · gas sponsored</p>
          </div>

          <div className={`ds-strip-cell ds-in ${isPrimary ? "ds-strip-cell--ok" : "ds-strip-cell--forest"}`}>
            <p className="ds-strip-k">Primary name</p>
            {primary.kind === "checking" && <p className="ds-strip-note">checking…</p>}
            {isPrimary && (
              <>
                <p className="ds-strip-v ds-strip-v--name">{fullName}</p>
                <p className="ds-strip-note ds-strip-note--ok">
                  ✓ reverse record set
                  {primaryTx && (
                    <>
                      {" · "}
                      <a href={`https://sepolia.etherscan.io/tx/${primaryTx}`} target="_blank" rel="noreferrer">tx</a>
                    </>
                  )}
                </p>
              </>
            )}
            {primary.kind === "set" && !isPrimary && (
              <>
                <p className="ds-strip-v ds-strip-v--name">{primary.name}</p>
                <button className="ds-mini" onClick={onSetPrimary}>Use {fullName}</button>
              </>
            )}
            {(primary.kind === "unset" || primary.kind === "error") && (
              <>
                <p className="ds-strip-v ds-strip-v--name" style={{ color: "var(--on-paper-faint)" }}>
                  not set
                </p>
                <button className="ds-mini" onClick={onSetPrimary}>Set as primary</button>
              </>
            )}
            {primary.kind === "pending" && (
              <button className="ds-mini" disabled>Approve with your passkey…</button>
            )}
            {primary.kind === "error" && (
              <p className="ds-strip-note ds-strip-note--err">{primary.message}</p>
            )}
          </div>

          <div className={`ds-strip-cell ds-in ${hasGuardians ? "ds-strip-cell--ok" : "ds-strip-cell--warn"}`}>
            <p className="ds-strip-k">Guardians</p>
            <p className={`ds-strip-v ${hasGuardians ? "" : "ds-strip-v--warn"}`}>
              {recovery === null ? "—" : hasGuardians ? `${recovery.threshold}/${recovery.count}` : "0"}
            </p>
            <p className={`ds-strip-note ${hasGuardians ? "ds-strip-note--ok" : "ds-strip-note--warn"}`}>
              {hasGuardians
                ? "threshold of registered guardians"
                : "no way back in if you lose this device"}
            </p>
          </div>
        </div>

        {/* the three surfaces, each showing real state */}
        <div className="ds-acts">
          <Link href="/agents" className="ds-act ds-in">
            <div className="ds-act-top">
              <span className="ds-act-ic" aria-hidden>⌘</span>
              <span className="ds-act-name">agents<span>.{session.label}</span></span>
              <span className="ds-act-pill">delegate</span>
            </div>
            <h3>Let something act for you</h3>
            <p>
              Grant a bot permission to call one function, capped per day and expiring
              on a date. Every agent is a subname you can burn.
            </p>
            <span className="ds-act-go">Manage agents <i aria-hidden>→</i></span>
          </Link>

          <Link href="/recovery" className="ds-act ds-in">
            <div className="ds-act-top">
              <span className={`ds-act-ic ${hasGuardians ? "ds-act-ic--ok" : "ds-act-ic--warn"}`} aria-hidden>
                ◇
              </span>
              <span className="ds-act-name">recovery<span>.{session.label}</span></span>
              {hasGuardians ? (
                <span className="ds-act-pill ds-act-pill--live">
                  {recovery!.threshold} of {recovery!.count}
                </span>
              ) : (
                <span className="ds-act-pill ds-act-pill--warn">not set up</span>
              )}
            </div>
            <h3>
              {hasGuardians ? "Recovery is armed" : "Get a way back in"}
            </h3>
            <p>
              {hasGuardians
                ? "Guardians can restore access to a new passkey after a timelock, and you can veto it."
                : "Add guardians — an ENS name, a wallet, or an email — before you need them."}
            </p>
            <span className="ds-act-go">
              {hasGuardians ? "Review guardians" : "Set up recovery"} <i aria-hidden>→</i>
            </span>
          </Link>

          <Link href="/install" className="ds-act ds-in">
            <div className="ds-act-top">
              <span className="ds-act-ic" aria-hidden>↗</span>
              <span className="ds-act-name">sign-in</span>
              <span className="ds-act-pill">bookmarklet</span>
            </div>
            <h3>Use your name anywhere</h3>
            <p>
              Drag one bookmarklet and any dApp that calls window.ethereum sees your
              account as a real signer.
            </p>
            <span className="ds-act-go">Get the bookmarklet <i aria-hidden>→</i></span>
          </Link>
        </div>

      </main>

      <footer className="ds-footer">
        <div className="ds-footer-in">
          <span className="ds-footer-who">
            <i /> Signed in as <b>{fullName}</b>
          </span>
          <span className="ds-footer-links">
            <Link href="/pitch">Pitch</Link>
            <a
              href="https://github.com/LeoFranklin015/ENSign"
              target="_blank" rel="noreferrer"
            >
              GitHub
            </a>
            <a
              href={`https://explorer.ens.dev/${fullName}`}
              target="_blank" rel="noreferrer"
            >
              ENS explorer ↗
            </a>
          </span>
        </div>
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
