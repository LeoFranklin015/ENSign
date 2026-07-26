"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  createWalletClient,
  custom,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import "../app/system.css";
import {
  connectInjected,
  connectTo,
  connectWalletConnect,
  discoverWallets,
  ensureChain,
  type Connection,
  type DetectedWallet,
} from "@/lib/guardianWallet";
import {
  CHAIN,
  CHAIN_ID,
  PARENT_NAME,
  createPasskeyForLabel,
  publicClient,
  resolveLabel,
} from "@/lib/ensign";

/**
 * PUBLIC recovery — deliberately not behind a session.
 *
 * The person recovering has lost the passkey, so they cannot sign in; and a
 * guardian was never an account holder here at all. Gating this page behind
 * auth made it unreachable by exactly the two people who need it. Everything
 * that matters is verified on-chain anyway: proofs carry their own
 * authorisation, so a public page grants no power.
 *
 *   /recover?name=leo.ensign.eth   or   /recover?account=0x…
 */

const MANAGER = (process.env.NEXT_PUBLIC_RECOVERY_MANAGER ??
  "0xD952928319e72c3F96eBD3e6398a8421f0865846") as Address;
const ECDSA_PROVIDER = (process.env.NEXT_PUBLIC_ECDSA_PROVIDER ??
  "0x97F9EFfAF5399a637b98359cda3cBf7493a0Ebf5") as Address;
const ZKEMAIL_PROVIDER = (process.env.NEXT_PUBLIC_ZKEMAIL_PROVIDER ??
  "0x8AD2E487a82fb14C689a5D85f6FE53EF7B427E90") as Address;

const managerAbi = parseAbi([
  "function getRecoveries(address account) view returns ((address provider, bytes commitment, uint32 delay)[])",
  "function recoveryThreshold(address account) view returns (uint256)",
  "function recoveryNonce(address account) view returns (uint256)",
  "function requestRecovery(address account, bytes subject, (bytes32 recoveryId, bytes proof)[] approvals) returns (bytes32)",
  "function executeRecoveryRequest(bytes32 requestId)",
  "function recoveryRequest(bytes32 requestId) view returns ((address account, uint64 executeAt, bytes subject))",
]);

const zkProviderAbi = parseAbi([
  "function expectedCommand(address account, uint256 nonce, bytes subject) pure returns (string)",
  "function recoveryHash(address account, uint256 nonce, bytes subject) pure returns (bytes32)",
]);

const ZK_DKIM_REGISTRY = "0x3D3935B3C030893f118a84C92C66dF1B9E4169d6";
/// Must render to exactly what ZkEmailRecoveryProvider.expectedCommand returns.
const COMMAND_TEMPLATE = "Recover account {ethAddr} using recovery hash {string}";

type Recovery = { provider: Address; commitment: Hex; delay: number };

type EmailProofJson = {
  domainName: string;
  publicKeyHash: Hex;
  timestamp: number | string;
  maskedCommand: string;
  emailNullifier: Hex;
  accountSalt: Hex;
  isCodeExist: boolean;
  proof: Hex;
};

/// Encode exactly as ZkEmailRecoveryProvider.verify decodes it.
function encodeEmailProof(p: EmailProofJson): Hex {
  return encodeAbiParameters(
    [{
      type: "tuple",
      components: [
        { name: "domainName", type: "string" },
        { name: "publicKeyHash", type: "bytes32" },
        { name: "timestamp", type: "uint256" },
        { name: "maskedCommand", type: "string" },
        { name: "emailNullifier", type: "bytes32" },
        { name: "accountSalt", type: "bytes32" },
        { name: "isCodeExist", type: "bool" },
        { name: "proof", type: "bytes" },
      ],
    }],
    [{
      domainName: p.domainName,
      publicKeyHash: p.publicKeyHash,
      timestamp: BigInt(p.timestamp),
      maskedCommand: p.maskedCommand,
      emailNullifier: p.emailNullifier,
      accountSalt: p.accountSalt,
      isCodeExist: p.isCodeExist,
      proof: p.proof,
    }],
  );
}
type Sig = { recoveryId: Hex; proof: Hex; signer: string };

/// The relayer's own status vocabulary, in the order it moves through.
const RELAY_STEPS = ["Sent", "Replied", "Proving", "Done"] as const;

function relayStage(status: string | null): number {
  if (!status) return 0;
  const t = status.toLowerCase();
  if (t.includes("finished") || t.includes("received —") || t.includes("approval received")) return 4;
  if (t.includes("proving")) return 3;
  if (t.includes("emailresponsereceived") || t.includes("replied")) return 2;
  if (t.includes("emailsent") || t.includes("sent")) return 1;
  return 1;
}

function short(a: string) {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

function MailIcon() {
  return (
    <svg className="ds-ic-svg" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="4" width="16" height="12" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.8 5.6 10 11l7.2-5.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg className="ds-ic-svg" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="4.5" width="16" height="12" rx="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2 8.2h16" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="14.3" cy="12.4" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** Approvals collected against the threshold. */
function Wheel({ have, need }: { have: number; need: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = need === 0 ? 0 : Math.min(1, have / need);
  const done = have >= need && need > 0;
  return (
    <div className="ds-wheel-wrap">
      <svg className="ds-wheel-svg" viewBox="0 0 62 62">
        <circle className="ds-wheel-track" cx="31" cy="31" r={r} fill="none" strokeWidth="5" />
        <circle
          className={`ds-wheel-fill ${done ? "ds-wheel-fill--done" : ""}`}
          cx="31" cy="31" r={r} fill="none" strokeWidth="5"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
        />
      </svg>
      <span className="ds-wheel-num">{have}/{need || "—"}</span>
    </div>
  );
}

export default function RecoverContent() {
  const params = useSearchParams();
  const nameParam = params.get("name");
  const accountParam = params.get("account") as Address | null;

  const [target, setTarget] = useState<Address | null>(accountParam);
  const [displayName, setDisplayName] = useState<string>(nameParam ?? "");
  const [lookup, setLookup] = useState(nameParam ?? "");
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [threshold, setThreshold] = useState(0);
  const [nonce, setNonce] = useState<bigint>(0n);

  const [newKey, setNewKey] = useState<{ qx: Hex; qy: Hex } | null>(null);
  const [sigs, setSigs] = useState<Sig[]>([]);
  const [conn, setConn] = useState<Connection | null>(null);
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [requestId, setRequestId] = useState<Hex | null>(null);
  const [executeAt, setExecuteAt] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [accountCode, setAccountCode] = useState("");
  const [emailCommand, setEmailCommand] = useState<string | null>(null);
  const [tab, setTab] = useState<"wallet" | "email">("wallet");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Extensions announce themselves over EIP-6963; ask once on mount.
  useEffect(() => { void discoverWallets().then(setWallets); }, []);

  const load = useCallback(async (acct: Address) => {
    try {
      const [list, th, nc] = await Promise.all([
        publicClient.readContract({
          address: MANAGER, abi: managerAbi, functionName: "getRecoveries", args: [acct],
        }) as Promise<readonly Recovery[]>,
        publicClient.readContract({
          address: MANAGER, abi: managerAbi, functionName: "recoveryThreshold", args: [acct],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: MANAGER, abi: managerAbi, functionName: "recoveryNonce", args: [acct],
        }) as Promise<bigint>,
      ]);
      setRecoveries([...list]);
      setThreshold(Number(th));
      setNonce(nc);
      setErr(list.length === 0 ? "This account has no guardians — recovery isn't possible." : null);
    } catch (e) {
      setErr(`could not read recovery config: ${(e as Error).message}`);
    }
  }, []);

  // Resolve whatever the link carried.
  useEffect(() => {
    (async () => {
      if (accountParam) { setTarget(accountParam); void load(accountParam); return; }
      if (!nameParam) return;
      try {
        const label = nameParam.replace(`.${PARENT_NAME}`, "");
        const r = await resolveLabel(label);
        setTarget(r.account);
        setDisplayName(`${label}.${PARENT_NAME}`);
        void load(r.account);
      } catch {
        setErr(`could not resolve ${nameParam}`);
      }
    })();
  }, [nameParam, accountParam, load]);

  async function findAccount() {
    setBusy("lookup"); setErr(null);
    try {
      const label = lookup.trim().replace(`.${PARENT_NAME}`, "");
      const r = await resolveLabel(label);
      setTarget(r.account);
      setDisplayName(`${label}.${PARENT_NAME}`);
      await load(r.account);
    } catch {
      setErr(`no account found for ${lookup}`);
    } finally { setBusy(null); }
  }

  async function connect(target: DetectedWallet | "walletconnect") {
    const key = target === "walletconnect" ? "walletconnect" : target.rdns;
    setBusy(key); setErr(null);
    try {
      const c = target === "walletconnect"
        ? await connectWalletConnect(CHAIN_ID)
        : await connectTo(target, CHAIN_ID);
      setConn(c);
      setNote(`connected ${short(c.address)} via ${c.via}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  /** Created on the recovering person's device, at the point it's needed. */
  async function makeKey() {
    setBusy("passkey"); setErr(null);
    try {
      const { qx, qy } = await createPasskeyForLabel(displayName || "recovered");
      setNewKey({ qx, qy });
      setNote("new passkey created on this device");
    } catch (e) {
      setErr(`passkey failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  async function signAsGuardian() {
    if (!newKey || !target) return;
    setBusy("sign"); setErr(null);
    try {
      const c = conn ?? await connectInjected(CHAIN_ID);
      if (!conn) setConn(c);
      // The wallet may have moved chains since it was connected.
      await ensureChain(c.provider, CHAIN_ID);
      const addr = c.address;
      const client = createWalletClient({ chain: CHAIN, transport: custom(c.provider) });

      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const mine = recoveries.find(
        (r) => r.provider.toLowerCase() === ECDSA_PROVIDER.toLowerCase() &&
          ("0x" + r.commitment.slice(26)).toLowerCase() === addr.toLowerCase(),
      );
      if (!mine) throw new Error(`${short(addr)} is not a guardian of this account`);

      const proof = await client.signTypedData({
        account: addr,
        domain: {
          name: "ECDSARecoveryProvider", version: "1",
          chainId: CHAIN_ID, verifyingContract: ECDSA_PROVIDER,
        },
        types: {
          Recover: [
            { name: "account", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "subject", type: "bytes" },
          ],
        },
        primaryType: "Recover",
        message: { account: target, nonce, subject },
      });

      const recoveryId = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "bytes" }],
          [target, mine.provider, mine.commitment],
        ),
      );
      setSigs((prev) =>
        prev.some((s) => s.recoveryId === recoveryId)
          ? prev
          : [...prev, { recoveryId, proof, signer: addr }]);
      setNote(`approval collected from ${short(addr)}`);
    } catch (e) {
      setErr(`signing failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  /// The exact line the guardian's email body has to carry.
  async function showCommand() {
    if (!newKey || !target) return;
    setBusy("command"); setErr(null);
    try {
      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const cmd = await publicClient.readContract({
        address: ZKEMAIL_PROVIDER, abi: zkProviderAbi,
        functionName: "expectedCommand", args: [target, nonce, subject],
      }) as string;
      setEmailCommand(cmd);
    } catch (e) {
      setErr(`could not read command: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  /**
   * Email the guardian and wait for their reply to come back as a proof.
   * Asking someone to export a .eml from Gmail is a hostile request; this is
   * the same cryptography with a reply as the only human step.
   */
  async function sendApprovalEmail() {
    if (!newKey || !target) return;
    if (!accountCode) { setErr("paste the account code saved when this guardian was added"); return; }
    const guardian = emailGuardians[0];
    if (!guardian) { setErr("no email guardian on this account"); return; }

    setBusy("email"); setErr(null);
    try {
      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const hash = await publicClient.readContract({
        address: ZKEMAIL_PROVIDER, abi: zkProviderAbi,
        functionName: "recoveryHash", args: [target, nonce, subject],
      }) as Hex;

      setEmailStatus("sending…");
      const sub = await fetch("/api/zkemail-relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          body: {
            dkimContractAddress: ZK_DKIM_REGISTRY,
            accountCode,
            codeExistsInEmail: true,
            commandTemplate: COMMAND_TEMPLATE,
            commandParams: [target, hash],
            templateId: "0x1",
            emailAddress: guardianEmail.trim(),
            subject: "Approve an ENSign account recovery",
            body: "Reply to this email to approve installing a new passkey.",
          },
        }),
      });
      const subJson = (await sub.json()) as { id?: string; error?: string };
      if (!sub.ok || !subJson.id) throw new Error(subJson.error ?? `HTTP ${sub.status}`);
      setEmailStatus("email sent — the guardian replies, then this picks it up");

      // Poll until the reply has been ingested and proved.
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const st = await fetch("/api/zkemail-relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status", id: subJson.id }),
        });
        const stJson = (await st.json()) as {
          status?: string; proof?: EmailProofJson; error?: string;
        };
        setEmailStatus(`relayer: ${stJson.status ?? "…"}`);
        if (stJson.proof) {
          attachProof(stJson.proof, guardian);
          setEmailStatus(`approval received — "${stJson.proof.maskedCommand}"`);
          return;
        }
        if (stJson.status === "Failed") throw new Error("the relayer reported a failure");
      }
      throw new Error("timed out waiting for the reply");
    } catch (e) {
      setErr(`email approval failed: ${(e as Error).message}`);
      setEmailStatus(null);
    } finally { setBusy(null); }
  }

  /// Shared by both the emailed and the manually-proved routes.
  function attachProof(proof: EmailProofJson, guardian: Recovery) {
    if (!target) return;
    const recoveryId = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "bytes" }],
        [target, guardian.provider, guardian.commitment],
      ),
    );
    setSigs((prev) =>
      prev.some((x) => x.recoveryId === recoveryId)
        ? prev
        : [...prev, {
            recoveryId,
            proof: encodeEmailProof(proof),
            signer: `email @${proof.domainName}`,
          }]);
  }

  /// Fallback when no relayer is reachable: prove a saved .eml directly.
  async function proveEml(file: File) {
    if (!target) return;
    if (!accountCode) { setErr("paste the account code saved when this guardian was added"); return; }
    const guardian = recoveries.find(
      (r) => r.provider.toLowerCase() === ZKEMAIL_PROVIDER.toLowerCase(),
    );
    if (!guardian) { setErr("no email guardian on this account"); return; }

    setBusy("prove"); setErr(null);
    setNote("deriving circuit inputs and proving — this takes a few minutes…");
    try {
      const eml = await file.text();
      const res = await fetch("/api/zkemail-prove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eml, accountCode }),
      });
      const json = (await res.json()) as { proof?: EmailProofJson; error?: string };
      if (!res.ok || !json.proof) throw new Error(json.error ?? `HTTP ${res.status}`);

      attachProof(json.proof, guardian);
      setNote(`email approval attached — "${json.proof.maskedCommand}"`);
    } catch (e) {
      setErr(`proving failed: ${(e as Error).message}`);
      setNote(null);
    } finally { setBusy(null); }
  }

  /**
   * The platform broadcasts both transactions. Whoever is recovering has lost
   * a device and may hold no ETH at all; a guardian is doing a favour. Neither
   * should need gas — and the manager verifies everything on-chain regardless.
   */
  async function submit() {
    if (!newKey || !target) return;
    setBusy("submit"); setErr(null);
    try {
      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const res = await fetch("/api/recovery-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "request",
          account: target,
          subject,
          approvals: sigs.map((x) => ({ recoveryId: x.recoveryId, proof: x.proof })),
        }),
      });
      const json = (await res.json()) as { tx?: Hex; error?: string };
      if (!res.ok || !json.tx) throw new Error(json.error ?? `HTTP ${res.status}`);

      const id = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "bytes" }, { type: "uint256" }],
          [target, subject, nonce],
        ),
      );
      const req = await publicClient.readContract({
        address: MANAGER, abi: managerAbi, functionName: "recoveryRequest", args: [id],
      }) as { account: Address; executeAt: bigint; subject: Hex };
      setRequestId(id);
      setExecuteAt(Number(req.executeAt));
      setNote(`request queued · ${json.tx.slice(0, 10)}…`);
    } catch (e) {
      setErr(`request failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  async function execute() {
    if (!requestId) return;
    setBusy("execute"); setErr(null);
    try {
      const res = await fetch("/api/recovery-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "execute", requestId }),
      });
      const json = (await res.json()) as { tx?: Hex; error?: string };
      if (!res.ok || !json.tx) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNote("recovered — the new passkey now controls this account");
      setRequestId(null);
    } catch (e) {
      setErr(`execute failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  const ready = executeAt > 0 && now >= executeAt;
  const emailGuardians = recoveries.filter(
    (r) => r.provider.toLowerCase() === ZKEMAIL_PROVIDER.toLowerCase(),
  );
  const enough = threshold > 0 && sigs.length >= threshold;

  return (
    <div className="ds ds-page">
      <nav className="ds-nav">
        <div className="ds-nav-in">
          <a href="/" className="ds-brand" style={{ textDecoration: "none" }}>
            ENSign <span>ENS v2</span>
          </a>
          <div className="ds-nav-right">
            <span className="ds-navlink">Account recovery</span>
          </div>
        </div>
      </nav>

      <main className="ds-wrap ds-app">
        <div className="ds-rec-head">
          <h1>Recover an account</h1>
          {target ? (
            <span className="ds-rec-target">
              <WalletIcon /> {displayName || short(target)}
            </span>
          ) : (
            <p className="ds-lede" style={{ margin: "0 auto" }}>
              Anyone can run this — the account holder doesn&apos;t need to be here.
            </p>
          )}
        </div>

        {err && <div className="agents-err">{err}</div>}
        {note && <div className="agents-note">{note}</div>}

        {!target ? (
          <div className="ds-off" style={{ paddingTop: 32 }}>
            <div className="ds-pane-h" style={{ justifyContent: "center" }}>
              <h3>Which account?</h3>
            </div>
            <div className="ag-row" style={{ justifyContent: "center" }}>
              <input
                className="ag-input ag-input--inline"
                placeholder={`name.${PARENT_NAME}`}
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void findAccount(); }}
              />
              <button className="ds-btn" disabled={!!busy || !lookup.trim()} onClick={findAccount}>
                {busy === "lookup" ? "…" : "Find"}
              </button>
            </div>
          </div>
        ) : (
          <div className="ds-split2" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <section className="ds-pane">
              <div className="ds-wheel">
                <Wheel have={sigs.length} need={threshold} />
                <div>
                  <p className="ds-wheel-t">
                    {enough ? "Enough approvals" : "Collecting approvals"}
                  </p>
                  <p className="ds-wheel-s">
                    {threshold === 0
                      ? "No guardians on this account."
                      : `${threshold} of ${recoveries.length} guardians must approve.`}
                  </p>
                </div>
              </div>

              {sigs.length > 0 && (
                <div className="ds-glist" style={{ marginTop: 18 }}>
                  {sigs.map((s) => (
                    <div className="ds-grow" key={s.recoveryId}>
                      <span className="ds-grow-ic" aria-hidden>
                        {s.signer.startsWith("email") ? <MailIcon /> : <WalletIcon />}
                      </span>
                      <span className="ds-grow-b">
                        <div className="ds-grow-t">
                          {s.signer.startsWith("email") ? s.signer : short(s.signer)}
                        </div>
                        <div className="ds-grow-s">approval collected</div>
                      </span>
                      <span style={{ color: "var(--data)", fontSize: 14 }}>✓</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="ds-flow">
              <div className="ds-step">
                <div className="ds-step-h">
                  <span className="ds-step-n">1</span>
                  <h4>Create your new passkey</h4>
                  {newKey && <span className="ds-step-done">✓ ready</span>}
                </div>
                <p className="ag-hint">
                  Made on this device, right now — this is the key guardians will authorise.
                </p>
                <button className="ds-btn" style={{ marginTop: 12 }} disabled={!!busy} onClick={makeKey}>
                  {busy === "passkey" ? "…" : newKey ? "Create another" : "Create passkey"}
                </button>
              </div>

              <div className={`ds-step ${newKey ? "" : "ds-step--muted"}`}>
                <div className="ds-step-h">
                  <span className="ds-step-n">2</span>
                  <h4>A guardian approves</h4>
                </div>

                {/* whichever kind of guardian is standing here */}
                <div className="ds-tabs" style={{ marginBottom: 16 }}>
                  <button
                    className={`ds-tab-btn ${tab === "wallet" ? "ds-tab-btn--on" : ""}`}
                    onClick={() => setTab("wallet")}
                  >
                    Wallet
                  </button>
                  <button
                    className={`ds-tab-btn ${tab === "email" ? "ds-tab-btn--on" : ""}`}
                    onClick={() => setTab("email")}
                  >
                    Email
                  </button>
                </div>

                {tab === "wallet" && (
                  <>
                    {conn ? (
                      <div className="ds-connect">
                        <span className="ds-connect-ic"><WalletIcon /></span>
                        <span className="ds-connect-b">
                          <div className="ds-connect-t">
                            Connected via {conn.via === "injected" ? "browser wallet" : "WalletConnect"}
                          </div>
                          <div className="ds-connect-s">{conn.address}</div>
                        </span>
                        <button className="ds-grow-x" title="Disconnect" onClick={() => setConn(null)}>
                          ×
                        </button>
                      </div>
                    ) : (
                      <div className="ds-wallets">
                        {wallets.map((w) => (
                          <button
                            key={w.rdns} className="ds-wallet"
                            disabled={!!busy} onClick={() => connect(w)}
                          >
                            {w.icon
                              ? <img className="ds-wallet-ic" src={w.icon} alt="" />
                              : <span className="ds-wallet-ic ds-wallet-ic--fb"><WalletIcon /></span>}
                            <span className="ds-wallet-n">
                              {busy === w.rdns ? "Connecting…" : w.name}
                            </span>
                            <span className="ds-wallet-tag">extension</span>
                          </button>
                        ))}

                        <button
                          className="ds-wallet" disabled={!!busy}
                          onClick={() => connect("walletconnect")}
                        >
                          <span className="ds-wallet-ic ds-wallet-ic--wc" aria-hidden>⌁</span>
                          <span className="ds-wallet-n">
                            {busy === "walletconnect" ? "Opening…" : "WalletConnect"}
                          </span>
                          <span className="ds-wallet-tag">scan with a phone</span>
                        </button>

                        {wallets.length === 0 && (
                          <p className="ag-hint">
                            No wallet extension detected — use WalletConnect to approve from a phone.
                          </p>
                        )}
                      </div>
                    )}
                    <button
                      className="ds-btn" style={{ marginTop: 12 }}
                      disabled={!!busy || !newKey}
                      onClick={signAsGuardian}
                    >
                      {busy === "sign" ? "…" : "Sign as guardian"}
                    </button>
                    <p className="ag-hint" style={{ marginTop: 10 }}>
                      Signing is free — no gas, no ETH needed. WalletConnect lets a guardian
                      approve from a phone by scanning a QR.
                    </p>
                  </>
                )}

                {tab === "email" && (
                  <>
                    {emailGuardians.length === 0 ? (
                      <p className="ag-hint">This account has no email guardians.</p>
                    ) : (
                      <>
                        <div className="ag-field">
                          <label className="ag-field-label">Guardian&apos;s email</label>
                          <input
                            className="ag-input"
                            placeholder="mom@gmail.com"
                            value={guardianEmail}
                            onChange={(e) => setGuardianEmail(e.target.value)}
                          />
                        </div>
                        <div className="ag-field" style={{ marginTop: 12 }}>
                          <label className="ag-field-label">Account code</label>
                          <input
                            className="ag-input"
                            placeholder="0x… saved when this guardian was added"
                            value={accountCode}
                            onChange={(e) => setAccountCode(e.target.value.trim())}
                          />
                        </div>

                        <button
                          className="ds-btn ds-btn--block" style={{ marginTop: 14 }}
                          disabled={!!busy || !newKey || !accountCode || !guardianEmail.trim()}
                          onClick={sendApprovalEmail}
                        >
                          {busy === "email" ? "Waiting for their reply…" : "Send approval email"}
                        </button>

                        {emailStatus && (() => {
                          const stage = relayStage(emailStatus);
                          const done = stage >= 4;
                          return (
                            <div className="ds-prog">
                              <div className="ds-prog-bar">
                                <div
                                  className={`ds-prog-fill ${done ? "ds-prog-fill--done" : "ds-prog-fill--live"}`}
                                  style={{ width: `${(stage / 4) * 100}%` }}
                                />
                              </div>
                              <div className="ds-prog-steps">
                                {RELAY_STEPS.map((label, i) => (
                                  <span
                                    key={label}
                                    className={stage > i + 1 ? "done" : stage === i + 1 ? "on" : ""}
                                  >
                                    {label}
                                  </span>
                                ))}
                              </div>
                              <p className="ds-prog-note">{emailStatus}</p>
                            </div>
                          );
                        })()}

                        <p className="ag-hint" style={{ marginTop: 10 }}>
                          They just reply to the email. The proof is generated from their
                          reply — the address never touches the chain.
                        </p>

                        <details style={{ marginTop: 14 }}>
                          <summary className="ag-hint">no relayer? prove a saved .eml instead</summary>
                          <button
                            className="ghost" style={{ marginTop: 10 }}
                            disabled={!!busy || !newKey} onClick={showCommand}
                          >
                            {busy === "command" ? "…" : "Show the line to email"}
                          </button>
                          {emailCommand && (
                            <div className="ds-codebox" style={{ marginTop: 10 }}>
                              <code>{emailCommand}</code>
                              <button
                                className="ds-copy"
                                onClick={() => navigator.clipboard?.writeText(emailCommand)}
                              >
                                Copy
                              </button>
                            </div>
                          )}
                          <input
                            type="file" accept=".eml,message/rfc822"
                            className="ag-input" style={{ marginTop: 10 }}
                            disabled={!!busy || !newKey || !accountCode}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) void proveEml(f); }}
                          />
                        </details>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className={`ds-step ${enough ? "" : "ds-step--muted"}`}>
                <div className="ds-step-h">
                  <span className="ds-step-n">3</span>
                  <h4>Submit and execute</h4>
                  {requestId && (
                    <span className="ds-step-done">
                      {ready ? "ready" : `${Math.max(0, executeAt - now)}s`}
                    </span>
                  )}
                </div>
                <div className="ag-row">
                  <button className="ds-btn" disabled={!!busy || !enough || !!requestId} onClick={submit}>
                    {busy === "submit" ? "…" : "Submit request"}
                  </button>
                  {requestId && (
                    <button className="ds-btn" disabled={!!busy || !ready} onClick={execute}>
                      {busy === "execute" ? "…" : "Execute"}
                    </button>
                  )}
                </div>
                <p className="ag-hint" style={{ marginTop: 10 }}>
                  The account owner can cancel during the timelock from any signed-in device.
                </p>
              </div>
            </section>
          </div>
        )}
      </main>

      <footer className="ds-footer">
        <div className="ds-footer-in">
          <span className="ds-footer-who"><i /> Public recovery · no sign-in required</span>
          <span className="ds-footer-links"><a href="/">ENSign</a></span>
        </div>
      </footer>
    </div>
  );
}
