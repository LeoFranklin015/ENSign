"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  encodeFunctionData,
  keccak256,
  namehash,
  parseAbi,
  toBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import "../app/app.css";
import { Nav } from "@/components/Nav";
import { MultiStepLoader, type Step } from "@/components/MultiStepLoader";
import { getSession } from "@/lib/session";
import {
  CHAIN_ID,
  PARENT_NAME,
  publicClient,
  sendUserOp,
} from "@/lib/ensign";

const MANAGER = process.env.NEXT_PUBLIC_MANAGER_ADDRESS as Address | undefined;
const BACKEND_BOT = (process.env.NEXT_PUBLIC_BACKEND_BOT_ADDRESS ??
  "") as `0x${string}`;
const STORAGE_REGISTRY: Address = "0x7caf267cF8DF169a583DDd22DbD95a58501C6d90";

const storageAbi = parseAbi([
  "function getTokenId(uint256) view returns (uint256)",
]);

const managerAbi = parseAbi([
  "function approve((address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends) permission) returns (bytes32 hash, uint256 tokenId)",
  "function revoke((address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends) permission)",
  "function getHash((address account,address spender,bytes32 parentNode,uint256 parentTokenId,string label,uint48 start,uint48 end,uint256 salt,(address target,bytes4 selector,address checker)[] calls,(address token,uint160 allowance,uint8 unit,uint16 multiplier)[] spends) permission) view returns (bytes32)",
] as readonly string[]) as Abi;

/// MultiOwnable surface on the canonical JustanAccount. We use it to grant
/// the manager owner rights so its `executeBatch` can call back into the
/// account. (V2 will use a scoped `setExecutor` once accounts migrate to
/// the SmartAccount.sol that supports it.)
const accountOwnerAbi = parseAbi([
  "function addOwnerAddress(address)",
  "function isOwnerAddress(address) view returns (bool)",
]);

/// PeriodUnit enum mirrors the contract's: 0=Minute 1=Hour 2=Day 3=Week 4=Month 5=Forever.
const PERIOD_UNITS = [
  { label: "min", value: 0 },
  { label: "hour", value: 1 },
  { label: "day", value: 2 },
  { label: "week", value: 3 },
  { label: "month", value: 4 },
] as const;

/// Manager's wildcard sentinels. `0x32…` (ASCII "2") is the only accepted
/// "any" value — `address(0)` reverts as `ZeroTarget` on validation.
/// `0xe0e0e0e0` is the synthetic selector the manager uses when calldata
/// is empty (i.e. plain ETH `value:` transfers).
const ANY_TARGET: Address = "0x3232323232323232323232323232323232323232";
const ANY_FN_SEL: Hex = "0x32323232";
const EMPTY_CALLDATA_FN_SEL: Hex = "0xe0e0e0e0";

/// Manager's NATIVE_TOKEN sentinel. Used in `SpendLimit.token` to cap how
/// much native ETH the agent can move per period.
const NATIVE_TOKEN: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/// Common ERC-20 selectors + native-ETH transfer marker. Custom 4-byte hex
/// also supported below.
const SELECTOR_PRESETS = [
  { label: "transfer", sig: "transfer(address,uint256)", selector: "0xa9059cbb" as Hex },
  { label: "approve", sig: "approve(address,uint256)", selector: "0x095ea7b3" as Hex },
  { label: "transferFrom", sig: "transferFrom(address,address,uint256)", selector: "0x23b872dd" as Hex },
  { label: "native (ETH)", sig: "<empty calldata>", selector: EMPTY_CALLDATA_FN_SEL },
] as const;

const EXPIRY_PRESETS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "1 year", days: 365 },
] as const;

type CallPermission = { target: Address; selector: Hex; checker: Address };
type SpendLimit = {
  token: Address;
  allowance: string;
  unit: number;
  multiplier: number;
};
type Execution = {
  txHash: Hex;
  blockNumber: string;
  target: Address;
  value: string;
  selector: Hex | null;
  at: string;
};

type PermissionDoc = {
  userAccount: Address;
  chainId: number;
  permissionHash: Hex;
  spender: Address;
  label: string;
  parentNode: Hex;
  parentTokenId: string;
  start: number;
  end: number;
  salt: string;
  calls: CallPermission[];
  spends: SpendLimit[];
  createdAt: string;
  createTxHash: Hex;
  revokedAt: string | null;
  revokeTxHash: Hex | null;
  executions?: Execution[];
};

const SCAN_BASE = "https://sepolia.etherscan.io";
const EXECUTE_STEPS: Step[] = [
  {
    id: "simulate",
    label: "simulate",
    description: "static call against the manager · catches reverts before broadcasting",
  },
  {
    id: "submit",
    label: "submit",
    description: "bot signs · manager.executeBatch · funds move from your account",
  },
  {
    id: "confirm",
    label: "confirm",
    description: "wait for receipt · log to history",
  },
];
const CREATE_STEPS: Step[] = [
  {
    id: "build",
    label: "build permission",
    description: "compute parent node · canonical hash via manager.getHash",
  },
  {
    id: "approve",
    label: "approve · sponsored",
    description: "passkey signs UserOp · adds manager owner (first time) · approves permission",
  },
  {
    id: "save",
    label: "save",
    description: "cache the full struct in mongo so the dashboard can list it",
  },
];

export default function AgentsContent() {
  const router = useRouter();
  const [session, setSession] = useState<ReturnType<typeof getSession>>(null);
  const [permissions, setPermissions] = useState<PermissionDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [executing, setExecuting] = useState<PermissionDoc | null>(null);
  const [busyHash, setBusyHash] = useState<Hex | null>(null);
  const [execNote, setExecNote] = useState<string | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace("/");
      return;
    }
    setSession(s);
    refresh(s.account);
  }, [router]);

  async function refresh(account: Address) {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/permissions?account=${account}&chainId=${CHAIN_ID}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "list failed");
      setPermissions(json.permissions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke(p: PermissionDoc) {
    if (!session) return;
    if (!MANAGER) {
      setError("NEXT_PUBLIC_MANAGER_ADDRESS not configured");
      return;
    }
    setBusyHash(p.permissionHash);
    setError(null);
    try {
      const permissionTuple = toPermissionTuple(p);
      const data = encodeFunctionData({
        abi: managerAbi,
        functionName: "revoke",
        args: [permissionTuple],
      });
      const r = await sendUserOp({
        account: session.account,
        credentialId: session.credentialId,
        target: MANAGER,
        data,
      });
      await fetch(`/api/permissions/${p.permissionHash}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: session.account, revokeTxHash: r.tx }),
      });
      await refresh(session.account);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyHash(null);
    }
  }

  async function runExecute(args: {
    p: PermissionDoc;
    target: Address;
    value: bigint;
    data: Hex;
    onStep: (id: string) => void;
  }) {
    const { p, target, value, data, onStep } = args;
    setBusyHash(p.permissionHash);
    setExecNote(null);
    setError(null);
    try {
      onStep("simulate");
      const wirePermission = {
        account: p.userAccount,
        spender: p.spender,
        parentNode: p.parentNode,
        parentTokenId: p.parentTokenId,
        label: p.label,
        start: p.start,
        end: p.end,
        salt: p.salt,
        calls: p.calls,
        spends: p.spends,
      };
      onStep("submit");
      const res = await fetch("/api/agent-execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          permission: wirePermission,
          calls: [{ target, value: value.toString(), data }],
          chainId: CHAIN_ID,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "execute failed");
      onStep("confirm");

      // Selector for history: first 4 bytes of data, or null for native.
      const selector =
        data && data !== "0x" && data.length >= 10 ? (data.slice(0, 10) as Hex) : null;
      await fetch(`/api/permissions/${p.permissionHash}/executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: p.userAccount,
          txHash: json.tx,
          blockNumber: json.blockNumber,
          target,
          value: value.toString(),
          selector,
        }),
      });

      setExecNote(`tx ${(json.tx as string).slice(0, 12)}… mined at block ${json.blockNumber}`);
      setExecuting(null);
      if (session) await refresh(session.account);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusyHash(null);
    }
  }

  if (!session) {
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
          <p className="kicker">delegate</p>
          <h1 className="hero-title-sm">
            agents on <em>your</em> account.
          </h1>
          <p className="hero-sub">
            Each agent gets an ENS subname under <strong>{session.label}.{PARENT_NAME}</strong>.
            Permissions are enforced on-chain by the manager — funds never leave your account.
          </p>
        </section>

        <div className="agents-toolbar">
          <button className="action" onClick={() => setShowCreate(true)}>
            + create agent
          </button>
        </div>

        {execNote && <div className="agents-note">executed · {execNote}</div>}
        {error && <div className="agents-err">{error}</div>}

        <div className="agents-list">
          {loading && <p className="muted">loading agents…</p>}
          {!loading && permissions.length === 0 && (
            <p className="muted">no agents yet — click create to mint one.</p>
          )}
          {permissions.map((p) => (
            <AgentCard
              key={p.permissionHash}
              p={p}
              parentName={`${session.label}.${PARENT_NAME}`}
              busy={busyHash === p.permissionHash}
              onExecute={() => setExecuting(p)}
              onRevoke={() => handleRevoke(p)}
            />
          ))}
        </div>
      </main>

      {showCreate && session && (
        <CreateAgentModal
          session={session}
          parentName={`${session.label}.${PARENT_NAME}`}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await refresh(session.account);
          }}
        />
      )}

      {executing && (
        <ExecuteAgentModal
          p={executing}
          parentName={`${session.label}.${PARENT_NAME}`}
          busy={busyHash === executing.permissionHash}
          onClose={() => setExecuting(null)}
          onRun={(args) => runExecute({ p: executing, ...args })}
        />
      )}
    </div>
  );
}

function shortHash(h: string, n = 8): string {
  if (!h || h.length < n + 4) return h;
  return `${h.slice(0, 6)}…${h.slice(-n)}`;
}

function humanRelPast(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ExecutionsPopover({
  executions,
  label,
  parentName,
  onClose,
}: {
  executions: Execution[];
  label: string;
  parentName: string;
  onClose: () => void;
}) {
  return (
    <div className="ag-modal-bg" onClick={onClose}>
      <div className="ag-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ag-modal-head">
          <p className="ag-kicker">// execution history</p>
          <h2 className="ag-h2">
            {label}.{parentName}
          </h2>
        </header>

        <div className="ag-modal-body">
          <ul className="ag-exec-list">
            {executions.map((ex, i) => (
              <li key={ex.txHash} className="ag-exec-item">
                <div className="ag-exec-item-head">
                  <span className="ag-exec-idx">#{executions.length - i}</span>
                  <a
                    href={`${SCAN_BASE}/tx/${ex.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="agent-link mono"
                  >
                    {shortHash(ex.txHash, 10)}
                  </a>
                  <span className="ag-exec-when">{humanRelPast(ex.at)}</span>
                </div>
                <div className="ag-exec-item-meta">
                  <span>
                    target <code>{shortAddr(ex.target)}</code>
                  </span>
                  <span>
                    value <code>{ex.value === "0" ? "0" : `${ex.value} wei`}</code>
                  </span>
                  {ex.selector && (
                    <span>
                      selector <code>{ex.selector}</code>
                    </span>
                  )}
                  <span>
                    block <code>{ex.blockNumber}</code>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <footer className="ag-modal-actions">
          <button onClick={onClose} className="ag-ghost" style={{ flex: 1 }}>
            close
          </button>
        </footer>
      </div>
    </div>
  );
}

function AgentCard({
  p,
  parentName,
  busy,
  onExecute,
  onRevoke,
}: {
  p: PermissionDoc;
  parentName: string;
  busy: boolean;
  onExecute: () => void;
  onRevoke: () => void;
}) {
  const [open, setOpen] = useState(false);
  const now = Math.floor(Date.now() / 1000);
  const isRevoked = !!p.revokedAt;
  const isExpired = p.end > 0 && p.end < now;
  const status = isRevoked ? "revoked" : isExpired ? "expired" : "active";
  const statusColor =
    status === "active" ? "lime" : status === "expired" ? "amber" : "red";
  const canExecute =
    !isRevoked &&
    !isExpired &&
    BACKEND_BOT &&
    p.spender.toLowerCase() === BACKEND_BOT.toLowerCase();

  const targetIsAny = p.calls[0]?.target.toLowerCase() ===
    "0x3232323232323232323232323232323232323232".toLowerCase();
  const selectorIsAny = p.calls[0]?.selector === "0x32323232";
  const selectorIsNative = p.calls[0]?.selector === "0xe0e0e0e0";
  const targetSummary = targetIsAny ? "* any" : shortAddr(p.calls[0]?.target ?? "0x0");
  const selectorSummary = selectorIsAny
    ? "* any fn"
    : selectorIsNative
      ? "native"
      : p.calls[0]?.selector ?? "—";
  const spendSummary =
    p.spends[0] != null
      ? `${p.spends[0].allowance} per ${PERIOD_UNITS[p.spends[0].unit]?.label ?? "?"}`
      : "no cap";
  const expiryRelative =
    p.end > 0 ? `expires ${humanRel(p.end)}` : "no expiry";
  const executions = (p.executions ?? []).slice().reverse();

  return (
    <div className="agent-card">
      <div className="agent-card-head">
        <div>
          <div className="agent-card-label">{p.label.toUpperCase()}</div>
          <a
            className="agent-card-sub"
            href={`${SCAN_BASE}/address/${p.spender}`}
            target="_blank"
            rel="noreferrer"
          >
            {p.label}.{parentName} → <code>{shortAddr(p.spender)}</code>
          </a>
        </div>
        <span className={`agent-status agent-status--${statusColor}`}>{status}</span>
      </div>

      <div className="agent-card-meta">
        <span>target {targetSummary}</span>
        <span>·</span>
        <span>fn {selectorSummary}</span>
        <span>·</span>
        <span>{spendSummary}</span>
        <span>·</span>
        <span>{expiryRelative}</span>
      </div>

      <div className="agent-card-ids">
        <span className="muted small">id</span>
        <code title={p.permissionHash}>{shortHash(p.permissionHash)}</code>
        <span className="muted small">·</span>
        <span className="muted small">created</span>
        <a
          href={`${SCAN_BASE}/tx/${p.createTxHash}`}
          target="_blank"
          rel="noreferrer"
          className="agent-link"
        >
          {shortHash(p.createTxHash)}
        </a>
        {p.revokeTxHash && (
          <>
            <span className="muted small">·</span>
            <span className="muted small">revoked</span>
            <a
              href={`${SCAN_BASE}/tx/${p.revokeTxHash}`}
              target="_blank"
              rel="noreferrer"
              className="agent-link"
            >
              {shortHash(p.revokeTxHash)}
            </a>
          </>
        )}
      </div>

      {executions.length > 0 && (
        <div className="agent-exec">
          <div className="agent-exec-row">
            <span className="agent-exec-eyebrow">latest execution</span>
            <span className="agent-exec-when">{humanRelPast(executions[0].at)}</span>
          </div>
          <a
            href={`${SCAN_BASE}/tx/${executions[0].txHash}`}
            target="_blank"
            rel="noreferrer"
            className="agent-exec-tx"
            title={executions[0].txHash}
          >
            <span className="agent-exec-tx-mono">{shortHash(executions[0].txHash, 10)}</span>
            <span className="agent-exec-arrow">↗</span>
          </a>
          <div className="agent-exec-meta">
            <span>→ {shortAddr(executions[0].target)}</span>
            {executions[0].value !== "0" && <span>· {executions[0].value} wei</span>}
            {executions[0].selector && <span>· {executions[0].selector}</span>}
          </div>
          {executions.length > 1 && (
            <button
              type="button"
              className="agent-exec-more"
              onClick={() => setOpen(true)}
            >
              + {executions.length - 1} more execution{executions.length - 1 === 1 ? "" : "s"}
            </button>
          )}
        </div>
      )}

      {open && (
        <ExecutionsPopover
          executions={executions}
          label={p.label}
          parentName={parentName}
          onClose={() => setOpen(false)}
        />
      )}

      <div className="agent-card-actions">
        {canExecute && (
          <button onClick={onExecute} disabled={busy}>
            {busy ? "executing…" : "execute"}
          </button>
        )}
        {!isRevoked && (
          <button className="ghost" onClick={onRevoke} disabled={busy}>
            {busy ? "…" : "revoke"}
          </button>
        )}
      </div>
    </div>
  );
}

function CreateAgentModal({
  session,
  parentName,
  onClose,
  onCreated,
}: {
  session: { label: string; account: Address; credentialId: string };
  parentName: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  // ─── Identity ────────────────────────────────────────────
  const [agentLabel, setAgentLabel] = useState("");
  const [spenderMode, setSpenderMode] = useState<"demo" | "custom">(
    BACKEND_BOT ? "demo" : "custom",
  );
  const [customSpender, setCustomSpender] = useState("");

  // ─── Scope ───────────────────────────────────────────────
  const [targetMode, setTargetMode] = useState<"specific" | "any">("specific");
  const [target, setTarget] = useState<string>("");
  const [selectorMode, setSelectorMode] = useState<"preset" | "custom" | "any">("preset");
  const [presetIdx, setPresetIdx] = useState(0);
  const [customSelector, setCustomSelector] = useState("");
  const [allowance, setAllowance] = useState("10");
  const [decimals, setDecimals] = useState(6);
  const [periodUnit, setPeriodUnit] = useState(2); // day
  const [periodMultiplier, setPeriodMultiplier] = useState(1);

  // ─── Lifetime ────────────────────────────────────────────
  const [expiryDays, setExpiryDays] = useState(7);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createStepId, setCreateStepId] = useState<string | null>(null);
  const [createDone, setCreateDone] = useState(false);

  const spender =
    spenderMode === "demo" ? BACKEND_BOT : (customSpender as `0x${string}`);

  const selectorHex: Hex = useMemo(() => {
    if (selectorMode === "any") return ANY_FN_SEL;
    if (selectorMode === "preset") return SELECTOR_PRESETS[presetIdx].selector;
    const s = customSelector.trim();
    if (s.match(/^0x[0-9a-fA-F]{8}$/)) return s as Hex;
    if (s.length > 0) {
      try {
        return keccak256(toBytes(s)).slice(0, 10) as Hex;
      } catch {
        return "0x00000000" as Hex;
      }
    }
    return "0x00000000" as Hex;
  }, [selectorMode, presetIdx, customSelector]);

  const selectorLabel =
    selectorMode === "any"
      ? "* any function"
      : selectorMode === "preset"
        ? SELECTOR_PRESETS[presetIdx].sig
        : customSelector || "—";

  const targetEffective: Address =
    targetMode === "any" ? ANY_TARGET : (target as Address);
  const targetLabel =
    targetMode === "any" ? "* any contract" : target || "—";

  const periodLabel = PERIOD_UNITS[periodUnit].label;
  const fullName = agentLabel ? `${agentLabel}.${parentName}` : "—";

  async function handleCreate() {
    setError(null);
    if (!MANAGER) {
      setError("NEXT_PUBLIC_MANAGER_ADDRESS not configured");
      return;
    }
    if (!agentLabel.match(/^[a-z0-9-]{1,32}$/)) {
      setError("label must be 1–32 chars · lowercase, numbers, hyphen");
      return;
    }
    if (!spender || !spender.match(/^0x[0-9a-fA-F]{40}$/)) {
      setError("spender must be a valid 0x address");
      return;
    }
    if (targetMode === "specific" && !target.match(/^0x[0-9a-fA-F]{40}$/)) {
      setError("target contract must be a valid 0x address (or pick 'any')");
      return;
    }
    if (!selectorHex.match(/^0x[0-9a-fA-F]{8}$/) || selectorHex === "0x00000000") {
      setError("selector must be a 4-byte hex or a function signature");
      return;
    }
    if (Number(allowance) < 0) {
      setError("allowance must be ≥ 0");
      return;
    }
    setBusy(true);
    setCreateStepId("build");
    setCreateDone(false);
    try {
      const parentNode = namehash(`${session.label}.${PARENT_NAME}`);
      const labelHash = BigInt(keccak256(toBytes(session.label)));
      const parentTokenId = (await publicClient.readContract({
        address: STORAGE_REGISTRY,
        abi: storageAbi,
        functionName: "getTokenId",
        args: [labelHash],
      })) as bigint;
      if (parentTokenId === 0n) {
        throw new Error("parentTokenId is zero — name not registered");
      }

      const start = Math.floor(Date.now() / 1000);
      const end = start + expiryDays * 24 * 60 * 60;
      const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(32))));
      const allowanceBig = BigInt(allowance) * 10n ** BigInt(decimals);
      // Spend cap is keyed by token address. The manager rejects any value/
      // token movement that doesn't have a matching SpendLimit entry, so we
      // synthesize the right one(s) from the call shape:
      //   - selector = native (empty calldata) → NATIVE_TOKEN
      //   - selector = any function → both NATIVE_TOKEN AND target token
      //   - selector = transfer/approve/etc on a specific target → target
      //   - target = wildcard → NATIVE_TOKEN (callee unknown at create time)
      const spends: Array<{
        token: Address;
        allowance: bigint;
        unit: number;
        multiplier: number;
      }> = [];
      const isNativeSelector = selectorHex === EMPTY_CALLDATA_FN_SEL;
      const isAnySelectorPick = selectorHex === ANY_FN_SEL;
      const targetIsConcrete = !!target.match(/^0x[0-9a-fA-F]{40}$/);

      if (isNativeSelector || isAnySelectorPick || targetMode === "any") {
        spends.push({
          token: NATIVE_TOKEN,
          allowance: allowanceBig,
          unit: periodUnit,
          multiplier: periodMultiplier,
        });
      }
      if (
        !isNativeSelector &&
        targetMode === "specific" &&
        targetIsConcrete
      ) {
        spends.push({
          token: target as Address,
          allowance: allowanceBig,
          unit: periodUnit,
          multiplier: periodMultiplier,
        });
      }
      // For "any function" with a typed target, also cap that token specifically.
      if (
        isAnySelectorPick &&
        targetMode === "specific" &&
        targetIsConcrete
      ) {
        spends.push({
          token: target as Address,
          allowance: allowanceBig,
          unit: periodUnit,
          multiplier: periodMultiplier,
        });
      }
      const permission = {
        account: session.account,
        spender: spender as Address,
        parentNode,
        parentTokenId,
        label: agentLabel,
        start,
        end,
        salt,
        calls: [
          {
            target: targetEffective,
            selector: selectorHex,
            checker: "0x0000000000000000000000000000000000000000" as Address,
          },
        ],
        spends,
      };

      const hash = (await publicClient.readContract({
        address: MANAGER,
        abi: managerAbi,
        functionName: "getHash",
        args: [permission],
      })) as Hex;

      // Pre-flight: ensure the manager is an owner of the user's account so
      // it can call back via `executeBatch`. If not, prepend `addOwnerAddress`
      // to the same UserOp — single sponsored tx for first-time setup + approve.
      const isMgrOwner = (await publicClient.readContract({
        address: session.account,
        abi: accountOwnerAbi,
        functionName: "isOwnerAddress",
        args: [MANAGER],
      })) as boolean;

      const approveData = encodeFunctionData({
        abi: managerAbi,
        functionName: "approve",
        args: [permission],
      });

      const calls: Array<{ to: Address; value?: bigint; data: Hex }> = [];
      if (!isMgrOwner) {
        calls.push({
          to: session.account,
          data: encodeFunctionData({
            abi: accountOwnerAbi,
            functionName: "addOwnerAddress",
            args: [MANAGER],
          }),
        });
      }
      calls.push({ to: MANAGER, data: approveData });

      setCreateStepId("approve");
      const r = await sendUserOp({
        account: session.account,
        credentialId: session.credentialId,
        calls,
      });

      setCreateStepId("save");

      await fetch("/api/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userAccount: session.account,
          chainId: CHAIN_ID,
          permissionHash: hash,
          spender,
          label: agentLabel,
          parentNode,
          parentTokenId: parentTokenId.toString(),
          start,
          end,
          salt: salt.toString(),
          calls: permission.calls,
          spends: permission.spends.map((s) => ({
            ...s,
            allowance: s.allowance.toString(),
          })),
          createTxHash: r.tx,
        }),
      });

      setCreateDone(true);
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const previewAllowance = `${allowance || "0"} × 10^${decimals}`;
  const previewPeriod =
    periodMultiplier > 1 ? `every ${periodMultiplier} ${periodLabel}s` : `per ${periodLabel}`;

  return (
    <div className="ag-modal-bg" onClick={onClose}>
      <div className="ag-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ag-modal-head">
          <p className="ag-kicker">// new permission</p>
          <h2 className="ag-h2">
            grant capability to a <em>name</em>.
          </h2>
        </header>

        <div className="ag-modal-body">
          {/* IDENTITY */}
          <section className="ag-section">
            <h3 className="ag-section-title">// identity</h3>

            <label className="ag-field">
              <span className="ag-field-label">agent label</span>
              <div className="ag-bigfield">
                <input
                  className="ag-bigfield-input"
                  placeholder="trader"
                  value={agentLabel}
                  onChange={(e) =>
                    setAgentLabel(e.target.value.toLowerCase().trim())
                  }
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="ag-bigfield-suffix">.{parentName}</span>
              </div>
            </label>

            <div className="ag-field">
              <span className="ag-field-label">spender (signing key)</span>
              <div className="ag-pills">
                <button
                  type="button"
                  className={`ag-pill ${spenderMode === "demo" ? "ag-pill--on" : ""}`}
                  onClick={() => setSpenderMode("demo")}
                  disabled={busy || !BACKEND_BOT}
                >
                  built-in demo bot
                </button>
                <button
                  type="button"
                  className={`ag-pill ${spenderMode === "custom" ? "ag-pill--on" : ""}`}
                  onClick={() => setSpenderMode("custom")}
                  disabled={busy}
                >
                  custom address
                </button>
              </div>
              {spenderMode === "demo" && BACKEND_BOT && (
                <div className="ag-hint mono">
                  → {BACKEND_BOT}
                </div>
              )}
              {spenderMode === "custom" && (
                <input
                  className="ag-input mono"
                  placeholder="0x…"
                  value={customSpender}
                  onChange={(e) => setCustomSpender(e.target.value.trim())}
                  disabled={busy}
                />
              )}
            </div>
          </section>

          {/* SCOPE */}
          <section className="ag-section">
            <h3 className="ag-section-title">// scope</h3>

            <div className="ag-field">
              <span className="ag-field-label">target contract</span>
              <div className="ag-pills">
                <button
                  type="button"
                  className={`ag-pill ${targetMode === "specific" ? "ag-pill--on" : ""}`}
                  onClick={() => setTargetMode("specific")}
                  disabled={busy}
                >
                  specific
                </button>
                <button
                  type="button"
                  className={`ag-pill ${targetMode === "any" ? "ag-pill--on" : ""}`}
                  onClick={() => setTargetMode("any")}
                  disabled={busy}
                  title="ANY_TARGET sentinel — agent can call any contract"
                >
                  * any contract
                </button>
              </div>
              {targetMode === "specific" ? (
                <input
                  className="ag-input mono"
                  placeholder="0x… (e.g. USDC token address)"
                  value={target}
                  onChange={(e) => setTarget(e.target.value.trim())}
                  disabled={busy}
                />
              ) : (
                <div className="ag-hint mono">
                  → ANY_TARGET sentinel ({ANY_TARGET}). Optional: paste a token
                  address below to track spend caps against it.
                  <input
                    className="ag-input mono"
                    style={{ marginTop: 8 }}
                    placeholder="0x… (token to cap spend on, optional)"
                    value={target}
                    onChange={(e) => setTarget(e.target.value.trim())}
                    disabled={busy}
                  />
                </div>
              )}
            </div>

            <div className="ag-field">
              <span className="ag-field-label">allowed call</span>
              <div className="ag-pills">
                {SELECTOR_PRESETS.map((p, i) => (
                  <button
                    type="button"
                    key={p.selector}
                    className={`ag-pill ${selectorMode === "preset" && presetIdx === i ? "ag-pill--on" : ""}`}
                    onClick={() => {
                      setSelectorMode("preset");
                      setPresetIdx(i);
                    }}
                    disabled={busy}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={`ag-pill ${selectorMode === "custom" ? "ag-pill--on" : ""}`}
                  onClick={() => setSelectorMode("custom")}
                  disabled={busy}
                >
                  custom
                </button>
                <button
                  type="button"
                  className={`ag-pill ${selectorMode === "any" ? "ag-pill--on" : ""}`}
                  onClick={() => setSelectorMode("any")}
                  disabled={busy}
                  title="ANY_FN_SEL sentinel — agent can call any function"
                >
                  * any function
                </button>
              </div>
              {selectorMode === "custom" ? (
                <input
                  className="ag-input mono"
                  placeholder="0xa9059cbb  or  transfer(address,uint256)"
                  value={customSelector}
                  onChange={(e) => setCustomSelector(e.target.value)}
                  disabled={busy}
                />
              ) : selectorMode === "any" ? (
                <div className="ag-hint mono">
                  → ANY_FN_SEL sentinel ({ANY_FN_SEL})
                </div>
              ) : (
                <div className="ag-hint mono">
                  selector {SELECTOR_PRESETS[presetIdx].selector} ·{" "}
                  {SELECTOR_PRESETS[presetIdx].sig}
                </div>
              )}
            </div>

            <div className="ag-field">
              <span className="ag-field-label">spend cap</span>
              <div className="ag-row">
                <input
                  className="ag-input ag-input--inline"
                  type="number"
                  min={0}
                  step="any"
                  value={allowance}
                  onChange={(e) => setAllowance(e.target.value)}
                  disabled={busy}
                  style={{ flex: "1 1 0" }}
                />
                <span className="ag-x">×</span>
                <span className="ag-decimals mono">
                  10^
                  <input
                    type="number"
                    min={0}
                    max={36}
                    value={decimals}
                    onChange={(e) => setDecimals(Number(e.target.value))}
                    disabled={busy}
                  />
                </span>
              </div>
              <div className="ag-row" style={{ marginTop: 10 }}>
                <span className="ag-prelabel">every</span>
                <input
                  className="ag-input ag-input--inline ag-input--num"
                  type="number"
                  min={1}
                  max={9999}
                  value={periodMultiplier}
                  onChange={(e) => setPeriodMultiplier(Math.max(1, Number(e.target.value) || 1))}
                  disabled={busy}
                />
                <div className="ag-pills ag-pills--tight">
                  {PERIOD_UNITS.map((u) => (
                    <button
                      type="button"
                      key={u.value}
                      className={`ag-pill ${periodUnit === u.value ? "ag-pill--on" : ""}`}
                      onClick={() => setPeriodUnit(u.value)}
                      disabled={busy}
                    >
                      {u.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* LIFETIME */}
          <section className="ag-section">
            <h3 className="ag-section-title">// lifetime</h3>

            <div className="ag-field">
              <span className="ag-field-label">expires in</span>
              <div className="ag-pills">
                {EXPIRY_PRESETS.map((e) => (
                  <button
                    type="button"
                    key={e.days}
                    className={`ag-pill ${expiryDays === e.days ? "ag-pill--on" : ""}`}
                    onClick={() => setExpiryDays(e.days)}
                    disabled={busy}
                  >
                    {e.label}
                  </button>
                ))}
                <span className="ag-prelabel">or</span>
                <input
                  className="ag-input ag-input--num"
                  type="number"
                  min={1}
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(Math.max(1, Number(e.target.value) || 1))}
                  disabled={busy}
                />
                <span className="ag-prelabel">days</span>
              </div>
            </div>
          </section>

          {/* PREVIEW */}
          <section className="ag-preview">
            <p className="ag-kicker">// preview</p>
            <pre className="ag-preview-body">
{`name      ${fullName}
spender   ${spender || "—"}
target    ${targetLabel}
call      ${selectorLabel}  (${selectorHex})
spend     ≤ ${previewAllowance} ${previewPeriod}
expiry    in ${expiryDays}d`}
            </pre>
          </section>

          {(createStepId || createDone || (busy && !error)) && (
            <section className="ag-loader-wrap">
              <MultiStepLoader
                steps={CREATE_STEPS}
                currentId={createDone ? null : createStepId}
                done={createDone}
                error={error}
              />
            </section>
          )}

          {error && <div className="ag-error">⚠ {error}</div>}
        </div>

        <footer className="ag-modal-actions">
          <button onClick={handleCreate} disabled={busy} className="action">
            {busy ? "minting…" : "mint permission"}
          </button>
          <button onClick={onClose} disabled={busy} className="ag-ghost">
            cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

function ExecuteAgentModal({
  p,
  parentName,
  busy,
  onClose,
  onRun,
}: {
  p: PermissionDoc;
  parentName: string;
  busy: boolean;
  onClose: () => void;
  onRun: (args: {
    target: Address;
    value: bigint;
    data: Hex;
    onStep: (id: string) => void;
  }) => Promise<void>;
}) {
  const call0 = p.calls[0];
  const isNative = call0?.selector === "0xe0e0e0e0";
  const isTransfer = call0?.selector === "0xa9059cbb";
  const isApprove = call0?.selector === "0x095ea7b3";
  const isAnyTarget = call0?.target.toLowerCase() ===
    "0x3232323232323232323232323232323232323232".toLowerCase();
  const isAnySelector = call0?.selector === "0x32323232";
  const decimals = 6; // assumes USDC-like decimals; matches create flow default

  // Form fields. We pick a reasonable default mode based on the permission.
  const [mode, setMode] = useState<"transfer" | "native" | "approve" | "raw">(
    isNative ? "native" : isApprove ? "approve" : isAnySelector ? "transfer" : "transfer",
  );
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [overrideTarget, setOverrideTarget] = useState("");
  const [rawData, setRawData] = useState<string>("0x");
  const [error, setError] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [doneFlag, setDoneFlag] = useState(false);

  const effectiveTarget: Address = isAnyTarget
    ? (overrideTarget as Address)
    : call0.target;

  const summary = useMemo(() => {
    if (mode === "native") {
      return `send ${amount} wei → ${recipient || "—"}`;
    }
    if (mode === "transfer") {
      return `transfer ${amount} (×10^${decimals}) → ${recipient || "—"}`;
    }
    if (mode === "approve") {
      return `approve ${recipient || "—"} for ${amount} (×10^${decimals})`;
    }
    return `raw call to ${effectiveTarget || "—"} · data ${rawData.slice(0, 10)}…`;
  }, [mode, amount, recipient, rawData, effectiveTarget]);

  async function go() {
    setError(null);
    setDoneFlag(false);
    setStepId(null);
    const onStep = (id: string) => setStepId(id);
    try {
      // Native mode: target IS the recipient — no contract pick needed.
      if (mode === "native") {
        if (!recipient.match(/^0x[0-9a-fA-F]{40}$/)) {
          throw new Error("recipient must be a valid 0x address");
        }
        await onRun({
          target: recipient as Address,
          value: BigInt(amount),
          data: "0x",
          onStep,
        });
        setDoneFlag(true);
        return;
      }

      // All other modes need a concrete contract address. If the permission
      // is wildcard-target, the user picks via overrideTarget; otherwise it
      // comes straight from the permission.
      if (isAnyTarget && !overrideTarget.match(/^0x[0-9a-fA-F]{40}$/)) {
        throw new Error("permission allows any target — pick one to call");
      }
      const target = effectiveTarget;
      let value = 0n;
      let data: Hex = "0x";

      if (mode === "transfer") {
        if (!recipient.match(/^0x[0-9a-fA-F]{40}$/)) {
          throw new Error("recipient must be a valid 0x address");
        }
        const a = BigInt(amount) * 10n ** BigInt(decimals);
        data = encodeFunctionData({
          abi: parseAbi(["function transfer(address,uint256)"]),
          functionName: "transfer",
          args: [recipient as Address, a],
        });
      } else if (mode === "approve") {
        if (!recipient.match(/^0x[0-9a-fA-F]{40}$/)) {
          throw new Error("spender must be a valid 0x address");
        }
        const a = BigInt(amount) * 10n ** BigInt(decimals);
        data = encodeFunctionData({
          abi: parseAbi(["function approve(address,uint256)"]),
          functionName: "approve",
          args: [recipient as Address, a],
        });
      } else if (mode === "raw") {
        if (!rawData.match(/^0x[0-9a-fA-F]*$/)) {
          throw new Error("raw data must be 0x-hex");
        }
        data = rawData as Hex;
      }

      await onRun({ target, value, data, onStep });
      setDoneFlag(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="ag-modal-bg" onClick={onClose}>
      <div className="ag-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ag-modal-head">
          <p className="ag-kicker">// execute as agent</p>
          <h2 className="ag-h2">
            run a call as <em>{p.label}</em>.
          </h2>
        </header>

        <div className="ag-modal-body">
          {/* PERMISSION CONTEXT */}
          <section className="ag-preview">
            <p className="ag-kicker">// permission</p>
            <pre className="ag-preview-body">
{`name      ${p.label}.${parentName}
spender   ${p.spender}
target    ${isAnyTarget ? "* any contract" : p.calls[0].target}
selector  ${p.calls[0].selector}${
  isTransfer
    ? "  (transfer)"
    : isNative
      ? "  (native ETH)"
      : isApprove
        ? "  (approve)"
        : isAnySelector
          ? "  (* any function)"
          : ""
}`}
            </pre>
          </section>

          {/* MODE PICKER */}
          {(isAnySelector || mode === "raw") && (
            <div className="ag-field">
              <span className="ag-field-label">action</span>
              <div className="ag-pills">
                <button
                  type="button"
                  className={`ag-pill ${mode === "transfer" ? "ag-pill--on" : ""}`}
                  onClick={() => setMode("transfer")}
                  disabled={busy}
                >
                  ERC-20 transfer
                </button>
                <button
                  type="button"
                  className={`ag-pill ${mode === "approve" ? "ag-pill--on" : ""}`}
                  onClick={() => setMode("approve")}
                  disabled={busy}
                >
                  ERC-20 approve
                </button>
                <button
                  type="button"
                  className={`ag-pill ${mode === "native" ? "ag-pill--on" : ""}`}
                  onClick={() => setMode("native")}
                  disabled={busy}
                >
                  native (ETH)
                </button>
                <button
                  type="button"
                  className={`ag-pill ${mode === "raw" ? "ag-pill--on" : ""}`}
                  onClick={() => setMode("raw")}
                  disabled={busy}
                >
                  raw calldata
                </button>
              </div>
            </div>
          )}

          {/* TARGET (only when permission allows any) */}
          {isAnyTarget && mode !== "native" && (
            <label className="ag-field">
              <span className="ag-field-label">target contract (any allowed)</span>
              <input
                className="ag-input mono"
                placeholder="0x…"
                value={overrideTarget}
                onChange={(e) => setOverrideTarget(e.target.value.trim())}
                disabled={busy}
              />
            </label>
          )}

          {/* TRANSFER / APPROVE / NATIVE */}
          {mode !== "raw" && (
            <>
              <label className="ag-field">
                <span className="ag-field-label">
                  {mode === "approve" ? "spender" : "recipient"}
                </span>
                <input
                  className="ag-input mono"
                  placeholder="0x…"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                  disabled={busy}
                />
              </label>
              <label className="ag-field">
                <span className="ag-field-label">
                  amount {mode === "native" ? "(wei)" : `(× 10^${decimals})`}
                </span>
                <input
                  className="ag-input mono"
                  type="text"
                  inputMode="decimal"
                  placeholder={mode === "native" ? "1000000000000000" : "1"}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.trim())}
                  disabled={busy}
                />
              </label>
            </>
          )}

          {/* RAW */}
          {mode === "raw" && (
            <label className="ag-field">
              <span className="ag-field-label">calldata</span>
              <input
                className="ag-input mono"
                placeholder="0x…"
                value={rawData}
                onChange={(e) => setRawData(e.target.value.trim())}
                disabled={busy}
              />
            </label>
          )}

          {/* SUMMARY */}
          <section className="ag-preview">
            <p className="ag-kicker">// will run</p>
            <pre className="ag-preview-body">{summary}</pre>
          </section>

          {(stepId || doneFlag || (busy && !error)) && (
            <section className="ag-loader-wrap">
              <MultiStepLoader
                steps={EXECUTE_STEPS}
                currentId={doneFlag ? null : stepId}
                done={doneFlag}
                error={error}
              />
            </section>
          )}

          {error && <div className="ag-error">⚠ {error}</div>}
        </div>

        <footer className="ag-modal-actions">
          <button onClick={go} disabled={busy} className="action">
            {busy ? "executing…" : "execute"}
          </button>
          <button onClick={onClose} disabled={busy} className="ag-ghost">
            cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

function toPermissionTuple(p: PermissionDoc) {
  return {
    account: p.userAccount,
    spender: p.spender,
    parentNode: p.parentNode,
    parentTokenId: BigInt(p.parentTokenId),
    label: p.label,
    start: p.start,
    end: p.end,
    salt: BigInt(p.salt),
    calls: p.calls,
    spends: p.spends.map((s) => ({
      ...s,
      allowance: BigInt(s.allowance),
    })),
  };
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function humanRel(unixTs: number): string {
  const diff = unixTs - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "expired";
  const days = Math.floor(diff / 86400);
  if (days >= 1) return `in ${days}d`;
  const hours = Math.floor(diff / 3600);
  if (hours >= 1) return `in ${hours}h`;
  return `in ${Math.floor(diff / 60)}m`;
}
