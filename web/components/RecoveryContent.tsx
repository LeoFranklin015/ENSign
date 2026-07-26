"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createWalletClient,
  custom,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { Nav } from "@/components/Nav";
import { getSession } from "@/lib/session";
import {
  CHAIN,
  CHAIN_ID,
  PARENT_NAME,
  createPasskeyForLabel,
  publicClient,
  sendUserOp,
} from "@/lib/ensign";

// ── deployed recovery stack (Sepolia) ────────────────────────────────────────
const MANAGER = (process.env.NEXT_PUBLIC_RECOVERY_MANAGER ??
  "0xD952928319e72c3F96eBD3e6398a8421f0865846") as Address;
const ENS_PROVIDER = (process.env.NEXT_PUBLIC_ENS_PROVIDER ??
  "0x8B1b7B3f634B4774F18101Ec15d24824b6E0f15c") as Address;
const ECDSA_PROVIDER = (process.env.NEXT_PUBLIC_ECDSA_PROVIDER ??
  "0x97F9EFfAF5399a637b98359cda3cBf7493a0Ebf5") as Address;
const ZKEMAIL_PROVIDER = (process.env.NEXT_PUBLIC_ZKEMAIL_PROVIDER ??
  "0x3AB8722fb2abF3875560c9bd4C3c932dEeF50397") as Address;
/// zkEmail's DKIM registry on Sepolia — the one our provider verifies against.
const ZK_DKIM_REGISTRY = "0x3D3935B3C030893f118a84C92C66dF1B9E4169d6";

const PROVIDER_NAMES: Record<string, string> = {
  [ENS_PROVIDER.toLowerCase()]: "ENSRecoveryProvider",
  [ECDSA_PROVIDER.toLowerCase()]: "ECDSARecoveryProvider",
  [ZKEMAIL_PROVIDER.toLowerCase()]: "ZkEmailRecoveryProvider",
};

/// Only the name's owner may re-point its subregistry, so this goes out as a
/// userOp from the account rather than through the platform relayer.
const storageAbi = parseAbi([
  "function setSubregistry(uint256 tokenId, address registry)",
]);

const managerAbi = parseAbi([
  "function addRecovery(address provider, bytes commitment, uint32 delay) returns (bytes32)",
  "function removeRecovery(bytes32 recoveryId)",
  "function setRecoveryThreshold(uint256 threshold)",
  "function requestRecovery(address account, bytes subject, (bytes32 recoveryId, bytes proof)[] approvals) returns (bytes32)",
  "function executeRecoveryRequest(bytes32 requestId)",
  "function cancelRecoveryRequest(bytes32 requestId)",
  "function getRecoveries(address account) view returns ((address provider, bytes commitment, uint32 delay)[])",
  "function recoveryThreshold(address account) view returns (uint256)",
  "function recoveryNonce(address account) view returns (uint256)",
  "function recoveryRequest(bytes32 requestId) view returns ((address account, uint64 executeAt, bytes subject))",
  "function computeRecoveryId(address account, address provider, bytes commitment) pure returns (bytes32)",
]);

const accountAbi = parseAbi([
  "function addOwnerAddress(address)",
  "function isOwnerAddress(address) view returns (bool)",
  "function isOwnerPublicKey(bytes32,bytes32) view returns (bool)",
]);

type Recovery = { provider: Address; commitment: Hex; delay: number };
type Sig = { recoveryId: Hex; proof: Hex; signer: string };

function short(a: string) {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

/** Decode a commitment into something human-readable per provider. */
function describeCommitment(r: Recovery): string {
  try {
    if (r.provider.toLowerCase() === ECDSA_PROVIDER.toLowerCase()) {
      return `EOA ${short(("0x" + r.commitment.slice(26)) as string)}`;
    }
    if (r.provider.toLowerCase() === ENS_PROVIDER.toLowerCase()) {
      const registry = ("0x" + r.commitment.slice(26, 66)) as string;
      return `ENS name in ${short(registry)}`;
    }
    if (r.provider.toLowerCase() === ZKEMAIL_PROVIDER.toLowerCase()) {
      const [salt, domain] = decodeAbiParameters(
        [{ type: "bytes32" }, { type: "string" }], r.commitment,
      );
      return `email @${domain} · salt ${short(salt as string)}`;
    }
    return "unknown provider";
  } catch {
    return "—";
  }
}

/**
 * A zkEmail account code: exactly 32 bytes (the relayer rejects any other
 * length) with a zeroed leading byte so the value stays below the BN254 field
 * modulus the circuit works in.
 */
function newAccountCode(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return ("0x00" + hex) as Hex;
}

/// accountSalt = Poseidon(emailAddress, accountCode), computed by our own API
/// route with relayer-utils. Same value a relayer would return, but same-origin
/// — no CORS, and no dependency on anyone else's uptime.
async function deriveAccountSalt(emailAddress: string, accountCode: Hex): Promise<Hex> {
  if (accountCode.length !== 66) {
    throw new Error(`account code must be 32 bytes, got ${(accountCode.length - 2) / 2}`);
  }
  const res = await fetch("/api/zkemail-salt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailAddress, accountCode }),
  });
  const json = (await res.json()) as { accountSalt?: string; error?: string };
  if (!res.ok || !json.accountSalt) {
    throw new Error(json.error ?? `salt derivation failed (HTTP ${res.status})`);
  }
  return json.accountSalt as Hex;
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

function MailIcon() {
  return (
    <svg className="ds-ic-svg" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="4" width="16" height="12" rx="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.8 5.6 10 11l7.2-5.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const zkProviderAbi = parseAbi([
  "function expectedCommand(address account, uint256 nonce, bytes subject) pure returns (string)",
  "function recoveryHash(address account, uint256 nonce, bytes subject) pure returns (bytes32)",
]);

/// zkEmail relayer — OPTIONAL. It only automates sending the guardian's email
/// and polling for the reply; the hosted one at relayer.zk.email currently 404s
/// on its own prover backend. With just a prover (PROVER_URL, server-side) the
/// .eml upload path below does the same job without any mail infrastructure.
const RELAYER = process.env.NEXT_PUBLIC_ZKEMAIL_RELAYER ?? "";
const HAS_RELAYER = RELAYER.length > 0;

/// The relayer's template must render to exactly what the provider expects.
const COMMAND_TEMPLATE = "Recover account {ethAddr} using recovery hash {string}";

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

/// Relayer calls go through our own /api/zkemail-relay rather than straight to
/// the relayer: it only allows `authorization, accept, content-type` on CORS
/// preflight, so the ngrok-interstitial header the browser would need is
/// rejected. Server-to-server has no such constraint.
async function relayerSubmit(body: Record<string, unknown>): Promise<string> {
  const res = await fetch("/api/zkemail-relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "submit", body }),
  });
  const json = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !json.id) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.id;
}

/// Poll until the guardian has replied and the proof has been generated.
/// The relayer hands the proof back rather than broadcasting it, which is what
/// lets our own provider verify it.
async function relayerStatus(id: string): Promise<{
  status: string;
  proof?: EmailProofJson;
}> {
  const res = await fetch("/api/zkemail-relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "status", id }),
  });
  const json = (await res.json()) as {
    status?: string;
    proof?: EmailProofJson;
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { status: json.status ?? "Unknown", proof: json.proof };
}

/// ABI-encode an EmailProof exactly as `ZkEmailRecoveryProvider.verify` decodes it.
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

export default function RecoveryContent() {
  const [account, setAccount] = useState<Address | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [label, setLabel] = useState<string>("");

  const [optedIn, setOptedIn] = useState(false);
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [threshold, setThreshold] = useState<number>(1);
  const [nonce, setNonce] = useState<bigint>(0n);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // setup form
  const [guardianAddr, setGuardianAddr] = useState("");
  const [guardianLabel, setGuardianLabel] = useState("");
  const [delayMins, setDelayMins] = useState("0");
  const [thresholdInput, setThresholdInput] = useState("1");

  // email guardian
  const [guardianEmail, setGuardianEmail] = useState("");
  const [accountCode, setAccountCode] = useState<Hex | null>(null);
  const [emailProofJson, setEmailProofJson] = useState("");
  const [emailCommand, setEmailCommand] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailRequestId, setEmailRequestId] = useState<string | null>(null);

  // One job on screen at a time: which half of the product you're in, and
  // what the right pane is currently doing.
  const [mode, setMode] = useState<"protect" | "recover">("protect");
  const [pane, setPane] = useState<"summary" | "choose" | "eoa" | "email">("summary");
  const [drawer, setDrawer] = useState(false);
  // Shown after a successful email registration — losing this code kills the
  // guardian, so it gets a modal rather than a line of prose.
  const [showCode, setShowCode] = useState<Hex | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // recovery form
  const [targetAccount, setTargetAccount] = useState("");
  const [newKey, setNewKey] = useState<{ qx: Hex; qy: Hex } | null>(null);
  const [sigs, setSigs] = useState<Sig[]>([]);
  const [requestId, setRequestId] = useState<Hex | null>(null);
  const [executeAt, setExecuteAt] = useState<number>(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const s = getSession();
    if (s) {
      setAccount(s.account);
      setCredentialId(s.credentialId);
      setLabel(s.label);
      setTargetAccount(s.account);
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async (who?: Address) => {
    const target = who ?? account;
    if (!target) return;
    try {
      const [owned, list, th, nc] = await Promise.all([
        publicClient.readContract({
          address: target, abi: accountAbi, functionName: "isOwnerAddress", args: [MANAGER],
        }) as Promise<boolean>,
        publicClient.readContract({
          address: MANAGER, abi: managerAbi, functionName: "getRecoveries", args: [target],
        }) as Promise<readonly Recovery[]>,
        publicClient.readContract({
          address: MANAGER, abi: managerAbi, functionName: "recoveryThreshold", args: [target],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: MANAGER, abi: managerAbi, functionName: "recoveryNonce", args: [target],
        }) as Promise<bigint>,
      ]);
      setOptedIn(owned);
      setRecoveries([...list]);
      setThreshold(Number(th));
      setThresholdInput(String(Number(th)));
      setNonce(nc);
    } catch (e) {
      setErr(`read failed: ${(e as Error).message}`);
    }
  }, [account]);

  useEffect(() => { if (account) void refresh(account); }, [account, refresh]);

  // ── owner actions (passkey userOps) ────────────────────────────────────────

  async function ownerCall(what: string, data: Hex, to: Address): Promise<boolean> {
    if (!account || !credentialId) return false;
    setBusy(what); setErr(null); setNote(null);
    try {
      const res = await sendUserOp({ account, credentialId, target: to, data });
      setNote(`${what} ✓  tx ${short(res.tx)}`);
      await refresh();
      return true;
    } catch (e) {
      setErr(`${what} failed: ${(e as Error).message}`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Turn recovery on: opt the account in, and build the namespace that
   * guardians will live in.
   *
   * The namespace is provisioned here rather than lazily on the first guardian
   * so `recovery.<you>.ensign.eth` exists — and resolves — the moment recovery
   * is enabled. The platform deploys and pays for the registries; the account
   * adds the manager as an owner and re-points its own name at them, both in a
   * single passkey signature.
   */
  async function enableRecovery() {
    if (!account || !credentialId) return;
    setBusy("enable recovery"); setErr(null); setNote(null);
    try {
      const r = await fetch("/api/recovery-namespace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, account }),
      });
      const ns = await r.json();
      if (!r.ok) throw new Error(ns.error ?? "could not build the recovery namespace");

      const calls: Array<{ to: Address; data: Hex }> = [{
        to: account,
        data: encodeFunctionData({
          abi: accountAbi, functionName: "addOwnerAddress", args: [MANAGER],
        }),
      }];
      if (ns.needsSetSubregistry) {
        calls.push({
          to: ns.storageRegistry as Address,
          data: encodeFunctionData({
            abi: storageAbi, functionName: "setSubregistry",
            args: [BigInt(ns.userTokenId), ns.namespaceRegistry as Address],
          }),
        });
      }

      const res = await sendUserOp({ account, credentialId, calls });
      setNote(`${ns.recoveryName} is live ✓  tx ${short(res.tx)}`);
      await refresh();
    } catch (e) {
      setErr(`enable recovery failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Add a wallet guardian the way script/RecoveryDemo.s.sol does.
   *
   * The guardian gets a real subname — `mom.recovery.<you>.ensign.eth`, minted
   * to their wallet — and the commitment stored on-chain points at that NAME,
   * not at the address. The manager then resolves `ownerOf` live, so the
   * guardian can move wallets and stay a guardian.
   *
   * Two transactions in one signature: the platform mints the namespace and the
   * guardian name (it pays, and owning those registries grants no authority),
   * then the account re-points its own name at the namespace and registers the
   * recovery. That re-pointing is the one step only the passkey can authorise.
   */
  async function addEnsGuardian() {
    const g = guardianAddr.trim() as Address;
    const gl = guardianLabel.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(g)) { setErr("guardian must be a 0x address"); return; }
    if (!/^[a-z0-9-]{1,63}$/.test(gl)) {
      setErr("name must be lowercase letters, digits or hyphens"); return;
    }
    if (!account || !credentialId) return;

    setBusy(`add ${gl}`); setErr(null); setNote(null);
    try {
      const r = await fetch("/api/recovery-namespace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, account, guardianLabel: gl, guardianAddress: g }),
      });
      const ns = await r.json();
      if (!r.ok) throw new Error(ns.error ?? "could not mint the guardian name");

      const commitment = encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [ns.methodsRegistry as Address, BigInt(ns.resource)],
      );
      const delay = Math.max(0, Math.floor(Number(delayMins) || 0)) * 60;

      const calls: Array<{ to: Address; data: Hex }> = [];
      if (ns.needsSetSubregistry) {
        calls.push({
          to: ns.storageRegistry as Address,
          data: encodeFunctionData({
            abi: storageAbi, functionName: "setSubregistry",
            args: [BigInt(ns.userTokenId), ns.namespaceRegistry as Address],
          }),
        });
      }
      calls.push({
        to: MANAGER,
        data: encodeFunctionData({
          abi: managerAbi, functionName: "addRecovery",
          args: [ENS_PROVIDER, commitment, delay],
        }),
      });

      const res = await sendUserOp({ account, credentialId, calls });
      setNote(`${ns.guardianName} added ✓  tx ${short(res.tx)}`);
      setGuardianLabel(""); setGuardianAddr("");
      await refresh();
    } catch (e) {
      setErr(`add guardian failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Register an email guardian. The commitment is (accountSalt, domain) where
   * accountSalt = Poseidon(email, accountCode) — derived by zkEmail's relayer,
   * so the email address itself never touches the chain.
   */
  async function addEmailGuardian() {
    const email = guardianEmail.trim().toLowerCase();
    const domain = email.split("@")[1];
    if (!domain) { setErr("enter a full email address"); return; }
    setBusy("add email guardian"); setErr(null); setNote(null);
    try {
      // The account code is the guardian's secret half of their identity: it is
      // needed again to prove, so surface it for the user to save.
      // Must be exactly 32 bytes for the relayer, and below the BN254 field
      // modulus for the circuit — so draw 31 random bytes and zero the top one.
      const code = accountCode ?? newAccountCode();
      setAccountCode(code);

      const salt = await deriveAccountSalt(email, code);
      const commitment = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "string" }], [salt, domain],
      );
      const delay = Math.max(0, Math.floor(Number(delayMins) || 0)) * 60;
      const ok = await ownerCall(`add email guardian ${email}`,
        encodeFunctionData({
          abi: managerAbi, functionName: "addRecovery",
          args: [ZKEMAIL_PROVIDER, commitment, delay],
        }), MANAGER);
      if (ok) {
        setNote("email guardian registered");
        setDrawer(false);
        setShowCode(code);
      }
    } catch (e) {
      setErr(`add email guardian failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  /**
   * The full email-guardian approval loop: ask the relayer to email the
   * guardian with our command, wait for them to reply, then take the proof it
   * returns and attach it as an approval.
   */
  async function requestEmailApproval(r: Recovery) {
    if (!newKey) { setErr("generate the new passkey first"); return; }
    if (!accountCode) {
      setErr("paste the account code you saved when registering this email guardian");
      return;
    }
    const target = (targetAccount || account) as Address;
    setBusy("email approval"); setErr(null);
    try {
      const [, domain] = decodeAbiParameters(
        [{ type: "bytes32" }, { type: "string" }], r.commitment,
      ) as [Hex, string];
      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const currentNonce = await publicClient.readContract({
        address: MANAGER, abi: managerAbi, functionName: "recoveryNonce", args: [target],
      }) as bigint;
      const hash = await publicClient.readContract({
        address: ZKEMAIL_PROVIDER, abi: zkProviderAbi,
        functionName: "recoveryHash", args: [target, currentNonce, subject],
      }) as Hex;

      setEmailStatus("sending email…");
      const id = await relayerSubmit({
        dkimContractAddress: ZK_DKIM_REGISTRY,
        accountCode,
        codeExistsInEmail: true,
        commandTemplate: COMMAND_TEMPLATE,
        commandParams: [target, hash],
        templateId: "0x1",
        emailAddress: guardianEmail.trim() || `guardian@${domain}`,
        subject: `Approve recovery of ${label || "your ENSign account"}`,
        body: `Reply to this email to approve installing a new passkey on ${target}.`,
        // `chain` is injected server-side (ZKEMAIL_CHAIN) so it can match
        // whatever the relayer's config.json actually defines.
      });
      setEmailRequestId(id);
      setEmailStatus("email sent — reply to it, then this will pick up the proof");

      // Poll until the guardian replies and the proof is generated.
      for (let i = 0; i < 240; i++) {
        await new Promise((r2) => setTimeout(r2, 5000));
        const { status, proof } = await relayerStatus(id);
        setEmailStatus(`relayer: ${status}`);
        if (proof) {
          const recoveryId = keccak256(
            encodeAbiParameters(
              [{ type: "address" }, { type: "address" }, { type: "bytes" }],
              [target, r.provider, r.commitment],
            ),
          );
          setSigs((prev) =>
            prev.some((s) => s.recoveryId === recoveryId)
              ? prev
              : [...prev, {
                  recoveryId,
                  proof: encodeEmailProof(proof),
                  signer: `email @${proof.domainName}`,
                }]);
          setEmailStatus(`proof received — "${proof.maskedCommand}"`);
          return;
        }
        if (status === "Failed") throw new Error("relayer reported failure");
      }
      throw new Error("timed out waiting for the reply (20 min)");
    } catch (e) {
      setErr(`email approval failed: ${(e as Error).message}`);
      setEmailStatus(null);
    } finally { setBusy(null); }
  }

  /**
   * Prove a saved .eml through our own prover and attach the result as an
   * approval. No relayer involved: the guardian sends the email from any mail
   * client, you drop the .eml here, the server derives the circuit inputs and
   * calls the prover.
   */
  async function proveEmlAndAttach(file: File) {
    if (!accountCode) { setErr("paste the account code for this guardian first"); return; }
    const target = (targetAccount || account) as Address;
    const guardian = emailGuardians[0];
    if (!guardian) { setErr("no email guardian registered"); return; }

    setBusy("proving email"); setErr(null);
    setEmailStatus("deriving circuit inputs and proving — this takes a few minutes…");
    try {
      const eml = await file.text();
      const res = await fetch("/api/zkemail-prove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eml, accountCode }),
      });
      const json = (await res.json()) as { proof?: EmailProofJson; error?: string };
      if (!res.ok || !json.proof) throw new Error(json.error ?? `HTTP ${res.status}`);

      const recoveryId = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "bytes" }],
          [target, guardian.provider, guardian.commitment],
        ),
      );
      setSigs((prev) =>
        prev.some((s) => s.recoveryId === recoveryId)
          ? prev
          : [...prev, {
              recoveryId,
              proof: encodeEmailProof(json.proof!),
              signer: `email @${json.proof!.domainName}`,
            }]);
      setEmailProofJson(JSON.stringify(json.proof, null, 2));
      setEmailStatus(`proof attached — "${json.proof.maskedCommand}"`);
    } catch (e) {
      setErr(`proving failed: ${(e as Error).message}`);
      setEmailStatus(null);
    } finally { setBusy(null); }
  }

  /** Show the exact text a guardian's email must authorize for the current key. */
  async function showEmailCommand() {
    if (!newKey) { setErr("generate the new passkey first"); return; }
    const target = (targetAccount || account) as Address;
    setBusy("read command"); setErr(null);
    try {
      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const currentNonce = await publicClient.readContract({
        address: MANAGER, abi: managerAbi, functionName: "recoveryNonce", args: [target],
      }) as bigint;
      const cmd = await publicClient.readContract({
        address: ZKEMAIL_PROVIDER, abi: zkProviderAbi,
        functionName: "expectedCommand", args: [target, currentNonce, subject],
      }) as string;
      setEmailCommand(cmd);
    } catch (e) {
      setErr(`could not read command: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  /**
   * Attach a zkEmail proof as an approval. The proof JSON comes from the
   * relayer/prover (the email must authorize exactly the command above).
   */
  function attachEmailProof() {
    const target = (targetAccount || account) as Address;
    setErr(null);
    try {
      const p = JSON.parse(emailProofJson) as {
        domainName: string; publicKeyHash: Hex; timestamp: number | string;
        maskedCommand: string; emailNullifier: Hex; accountSalt: Hex;
        isCodeExist: boolean; proof: Hex;
      };
      const encoded = encodeAbiParameters(
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
      const match = recoveries.find(
        (r) => r.provider.toLowerCase() === ZKEMAIL_PROVIDER.toLowerCase() &&
          (decodeAbiParameters([{ type: "bytes32" }, { type: "string" }], r.commitment)[0] as string)
            .toLowerCase() === p.accountSalt.toLowerCase(),
      );
      if (!match) throw new Error("no registered email guardian matches this accountSalt");
      const recoveryId = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "bytes" }],
          [target, match.provider, match.commitment],
        ),
      );
      setSigs((prev) =>
        prev.some((s) => s.recoveryId === recoveryId)
          ? prev
          : [...prev, { recoveryId, proof: encoded, signer: `email @${p.domainName}` }]);
      setNote("email proof attached as an approval");
    } catch (e) {
      setErr(`bad proof JSON: ${(e as Error).message}`);
    }
  }

  const applyThreshold = () =>
    ownerCall(`set threshold ${thresholdInput}`,
      encodeFunctionData({
        abi: managerAbi, functionName: "setRecoveryThreshold",
        args: [BigInt(thresholdInput || "1")],
      }), MANAGER);

  const removeGuardian = (r: Recovery) => {
    const id = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "bytes" }],
        [account!, r.provider, r.commitment],
      ),
    );
    return ownerCall("remove guardian",
      encodeFunctionData({ abi: managerAbi, functionName: "removeRecovery", args: [id] }),
      MANAGER);
  };

  // ── guardian + relayer actions (injected wallet) ───────────────────────────

  async function wallet() {
    const eth = (window as unknown as { ethereum?: never }).ethereum;
    if (!eth) throw new Error("no injected wallet found (install MetaMask)");
    const client = createWalletClient({ chain: CHAIN, transport: custom(eth) });
    const [addr] = await client.requestAddresses();
    return { client, addr };
  }

  async function generateKey() {
    setBusy("create passkey"); setErr(null);
    try {
      const { qx, qy } = await createPasskeyForLabel(`${label || "recovered"}-new`);
      setNewKey({ qx, qy });
      setNote("new passkey created — guardians must now approve it");
    } catch (e) {
      setErr(`passkey failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  /** A guardian signs the EIP-712 approval in their own wallet. Gasless. */
  async function signAsGuardian() {
    if (!newKey) { setErr("generate the new passkey first"); return; }
    const target = (targetAccount || account) as Address;
    setBusy("guardian signature"); setErr(null);
    try {
      const { client, addr } = await wallet();
      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const currentNonce = await publicClient.readContract({
        address: MANAGER, abi: managerAbi, functionName: "recoveryNonce", args: [target],
      }) as bigint;

      // Find which registered recovery this signer owns (ECDSA commitments only).
      const list = await publicClient.readContract({
        address: MANAGER, abi: managerAbi, functionName: "getRecoveries", args: [target],
      }) as readonly Recovery[];
      const mine = list.find(
        (r) => r.provider.toLowerCase() === ECDSA_PROVIDER.toLowerCase() &&
          ("0x" + r.commitment.slice(26)).toLowerCase() === addr.toLowerCase(),
      );
      if (!mine) throw new Error(`${short(addr)} is not a registered guardian of this account`);

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
        message: { account: target, nonce: currentNonce, subject },
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
      setNote(`signature collected from ${short(addr)}`);
    } catch (e) {
      setErr(`signing failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  /** Anyone can relay the bundle once enough guardians have signed. */
  async function submitRequest() {
    if (!newKey) { setErr("no new key"); return; }
    const target = (targetAccount || account) as Address;
    setBusy("submit request"); setErr(null);
    try {
      const { client, addr } = await wallet();
      const subject = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }], [newKey.qx, newKey.qy],
      );
      const hash = await client.writeContract({
        account: addr, address: MANAGER, abi: managerAbi,
        functionName: "requestRecovery",
        args: [target, subject, sigs.map((s) => ({ recoveryId: s.recoveryId, proof: s.proof }))],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      // requestId = keccak256(account, subject, nonceUsed)
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
      setNote(`request queued — executable at ${new Date(Number(req.executeAt) * 1000).toLocaleTimeString()}`);
      await refresh(target);
    } catch (e) {
      setErr(`request failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  async function executeRequest() {
    if (!requestId) return;
    setBusy("execute"); setErr(null);
    try {
      const { client, addr } = await wallet();
      const hash = await client.writeContract({
        account: addr, address: MANAGER, abi: managerAbi,
        functionName: "executeRecoveryRequest", args: [requestId],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      const installed = await publicClient.readContract({
        address: (targetAccount || account) as Address, abi: accountAbi,
        functionName: "isOwnerPublicKey", args: [newKey!.qx, newKey!.qy],
      }) as boolean;
      setNote(installed
        ? "recovered — the new passkey is now an owner of the account"
        : "executed, but the key was not found as an owner");
      setRequestId(null);
      await refresh();
    } catch (e) {
      setErr(`execute failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }

  const cancelRequest = () =>
    requestId
      ? ownerCall("cancel request",
          encodeFunctionData({
            abi: managerAbi, functionName: "cancelRecoveryRequest", args: [requestId],
          }), MANAGER)
      : undefined;

  if (!account) {
    return (
      <>
        <Nav />
        <main className="ag-section">
          <h2 className="ag-h2">Recovery</h2>
          <p className="ag-hint mono">Sign in with your ENSign name first.</p>
        </main>
      </>
    );
  }

  const ready = executeAt > 0 && now >= executeAt;
  // The link guardians actually use — public, and resolvable without a session.
  const recoverLink =
    typeof window !== "undefined" && label
      ? `${window.location.origin}/recover?name=${label}.${PARENT_NAME}`
      : "/recover";
  const emailGuardians = recoveries.filter(
    (r) => r.provider.toLowerCase() === ZKEMAIL_PROVIDER.toLowerCase(),
  );

  return (
    <div className="ds ds-page">
      <Nav />

      <main className="ds-wrap ds-app">
        <header className="ds-idcard">
          <div>
            <h1 className="ds-idcard-name">Recovery</h1>
            <p className="ds-idcard-addr">
              guardians are subnames · {optedIn ? `${threshold} of ${recoveries.length} required` : "not enabled"}
            </p>
          </div>
          <div className="ds-idcard-actions">
            <div className="ds-tabs">
              <button
                className={`ds-tab-btn ${mode === "protect" ? "ds-tab-btn--on" : ""}`}
                onClick={() => setMode("protect")}
              >
                Protect
              </button>
              <button
                className={`ds-tab-btn ${mode === "recover" ? "ds-tab-btn--on" : ""}`}
                onClick={() => setMode("recover")}
              >
                Recover
              </button>
            </div>
          </div>
        </header>

        {err && <div className="agents-err">{err}</div>}
        {note && <div className="agents-note">{note}</div>}

        {/* ── PROTECT ─────────────────────────────────────────────────── */}
        {mode === "protect" && !optedIn && (
          <section className="ds-off ds-in">
            <div className="ds-off-ic" aria-hidden>!</div>
            <h2>Recovery is off</h2>
            <p>
              If you lose the device holding your passkey, there is no way back into
              this account. Turning recovery on lets people you trust restore access —
              and never lets them spend anything.
            </p>
            <div className="ds-off-why">
              <div><b>01</b><span>Guardians can only add a new passkey, never move funds.</span></div>
              <div><b>02</b><span>Every recovery waits out a timelock you can cancel.</span></div>
              <div><b>03</b><span>Guardians are names, so they keep working if someone changes wallet.</span></div>
            </div>
            <button className="ds-btn" disabled={!!busy} onClick={enableRecovery}>
              {busy === "enable recovery" ? "Approving…" : "Turn on recovery"}
            </button>
          </section>
        )}

        {mode === "protect" && optedIn && (
          <div className="ds-split2 ds-split2--solo">
            {/* left: who can vouch for you */}
            <aside className="ds-pane ds-in">
              <div className="ds-pane-h">
                <h3>Guardians</h3>
                <span className="ds-pane-count">{threshold} of {recoveries.length}</span>
              </div>

              {recoveries.length === 0 ? (
                <div className="ds-empty">
                  No guardians yet.<br />Add one to arm recovery.
                </div>
              ) : (
                <div className="ds-glist">
                  {recoveries.map((r, i) => (
                    <div className="ds-grow" key={i}>
                      <span className="ds-grow-ic" aria-hidden>
                        {r.provider.toLowerCase() === ZKEMAIL_PROVIDER.toLowerCase()
                          ? <MailIcon />
                          : <WalletIcon />}
                      </span>
                      <span className="ds-grow-b">
                        <div className="ds-grow-t">{describeCommitment(r)}</div>
                        <div className="ds-grow-s">
                          {PROVIDER_NAMES[r.provider.toLowerCase()] ?? short(r.provider)}
                          {r.delay > 0 ? ` · ${r.delay / 60}min delay` : " · no delay"}
                        </div>
                      </span>
                      <button
                        className="ds-grow-x"
                        title="Remove guardian"
                        disabled={!!busy}
                        onClick={() => removeGuardian(r)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                className="ds-btn ds-btn--block"
                style={{ marginTop: 14 }}
                disabled={!!busy}
                onClick={() => { setPane("choose"); setDrawer(true); }}
              >
                Add a guardian +
              </button>

              {recoveries.length >= 1 && (
                <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--rule-soft)" }}>
                  <p className="ds-strip-k">Threshold</p>
                  <div className="ag-row">
                    <input
                      className="ag-input ag-input--num"
                      value={thresholdInput}
                      onChange={(e) => setThresholdInput(e.target.value)}
                    />
                    <span className="ag-hint">of {recoveries.length} must approve</span>
                    <button className="ds-mini" style={{ width: "auto", marginTop: 0 }}
                            disabled={!!busy} onClick={applyThreshold}>
                      Set
                    </button>
                  </div>
                </div>
              )}
            </aside>

          </div>
        )}

        {/* ── RECOVER ─────────────────────────────────────────────────── */}
        {mode === "recover" && (
          <section className="ds-off ds-in">
            <div className="ds-off-ic" style={{ background: "rgba(203,246,60,.18)", color: "var(--forest)" }} aria-hidden>
              ↗
            </div>
            <h2>Recovery happens on a public page</h2>
            <p>
              Whoever lost the passkey can&apos;t sign in, and your guardians never had an
              account here. So the flow lives on a link anyone can open — nothing on it
              grants power, because every approval is verified on-chain.
            </p>

            <div className="ds-codebox" style={{ marginTop: 24 }}>
              <code>{recoverLink}</code>
              <button
                className="ds-copy"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(recoverLink);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 1600);
                  } catch { /* clipboard blocked */ }
                }}
              >
                {linkCopied ? "Copied ✓" : "Copy link"}
              </button>
            </div>

            <p className="ag-hint" style={{ marginTop: 14 }}>
              Save it somewhere you&apos;ll still reach without this device — and send it to
              your guardians when you need them.
            </p>

            <a className="ds-btn" style={{ marginTop: 20 }} href={recoverLink} target="_blank" rel="noreferrer">
              Open recovery page ↗
            </a>
          </section>
        )}
      </main>

      {/* ── add-guardian drawer ──────────────────────────────────────── */}
      {drawer && (
        <>
          <div className="ds-drawer-bg" onClick={() => !busy && setDrawer(false)} />
          <aside className="ds-drawer" role="dialog" aria-modal>
            <div className="ds-drawer-h">
              {pane !== "choose" && (
                <button className="ds-back" style={{ margin: 0 }} onClick={() => setPane("choose")}>
                  ←
                </button>
              )}
              <h3>
                {pane === "choose" && "Add a guardian"}
                {pane === "eoa" && "Wallet guardian"}
                {pane === "email" && "Email guardian"}
              </h3>
              <button className="ds-drawer-x" onClick={() => !busy && setDrawer(false)} aria-label="Close">
                ×
              </button>
            </div>

            <div className="ds-drawer-b">
              {pane === "choose" && (
                <div className="ds-methods">
                  <button className="ds-method" onClick={() => setPane("eoa")}>
                    <span className="ds-method-ic" aria-hidden><WalletIcon /></span>
                    <span>
                      <div className="ds-method-t">A wallet</div>
                      <div className="ds-method-s">
                        Someone with an Ethereum address. They approve by signing — free, no gas.
                      </div>
                    </span>
                    <span className="ds-method-go">→</span>
                  </button>

                  <button className="ds-method" onClick={() => setPane("email")}>
                    <span className="ds-method-ic" aria-hidden><MailIcon /></span>
                    <span>
                      <div className="ds-method-t">An email address</div>
                      <div className="ds-method-s">
                        They approve by replying to an email. Proven with zkEmail — the address
                        never touches the chain.
                      </div>
                    </span>
                    <span className="ds-method-go">→</span>
                  </button>
                </div>
              )}

              {pane === "eoa" && (
                <div className="ag-section">
                  <div className="ag-field">
                    <label className="ag-field-label">Call them</label>
                    <input
                      className="ag-input" placeholder="mom"
                      value={guardianLabel}
                      onChange={(e) => setGuardianLabel(e.target.value)}
                    />
                    <span className="ag-hint">
                      becomes {guardianLabel.trim().toLowerCase() || "mom"}.recovery.
                      {label || "you"}.{PARENT_NAME}
                    </span>
                  </div>
                  <div className="ag-field">
                    <label className="ag-field-label">Their address</label>
                    <input
                      className="ag-input" placeholder="0x…"
                      value={guardianAddr}
                      onChange={(e) => setGuardianAddr(e.target.value)}
                    />
                  </div>
                  <div className="ag-field">
                    <label className="ag-field-label">Timelock before their approval can execute</label>
                    <div className="ag-row">
                      <input
                        className="ag-input ag-input--num"
                        value={delayMins}
                        onChange={(e) => setDelayMins(e.target.value)}
                      />
                      <span className="ag-hint">minutes · you can cancel during this window</span>
                    </div>
                  </div>
                </div>
              )}

              {pane === "email" && (
                <div className="ag-section">
                  <div className="ag-field">
                    <label className="ag-field-label">Their email address</label>
                    <input
                      className="ag-input" placeholder="mom@gmail.com"
                      value={guardianEmail}
                      onChange={(e) => setGuardianEmail(e.target.value)}
                    />
                  </div>
                  <p className="ag-hint">
                    Only a hash reaches the chain — Poseidon(email, secret code). You&apos;ll get
                    the code to save once it&apos;s registered.
                  </p>
                </div>
              )}
            </div>

            {pane !== "choose" && (
              <div className="ds-drawer-f">
                <button
                  className="ds-btn ds-btn--block"
                  disabled={!!busy}
                  onClick={pane === "eoa" ? addEnsGuardian : addEmailGuardian}
                >
                  {busy ? "Approving…" : "Add guardian"}
                </button>
              </div>
            )}
          </aside>
        </>
      )}

      {/* ── account code, once the guardian exists ───────────────────── */}
      {showCode && (
        <div className="ds-modal-bg" onClick={() => setShowCode(null)}>
          <div className="ds-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <div className="ds-pane-h"><h3>Save this account code</h3></div>

            <div className="ds-code-warn">
              <span aria-hidden style={{ color: "var(--alert)", fontSize: 15 }}>!</span>
              <span>
                <b>You cannot see this again.</b>
                <p>
                  It is half of the guardian&apos;s identity. Without it this email can never
                  approve a recovery — store it in your password manager now.
                </p>
              </span>
            </div>

            <div className="ds-codebox">
              <code>{showCode}</code>
              <button
                className="ds-copy"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(showCode);
                    setCodeCopied(true);
                    setTimeout(() => setCodeCopied(false), 1600);
                  } catch { /* clipboard blocked */ }
                }}
              >
                {codeCopied ? "Copied ✓" : "Copy"}
              </button>
            </div>

            <button
              className="ds-btn ds-btn--block"
              style={{ marginTop: 18 }}
              onClick={() => setShowCode(null)}
            >
              I&apos;ve saved it
            </button>
          </div>
        </div>
      )}

      <footer className="ds-footer">
        <div className="ds-footer-in">
          <span className="ds-footer-who">
            <i /> {label ? `Signed in as ${label}` : "Recovery"}
          </span>
          <span className="ds-footer-links">
            <a href="/dashboard">Wallet</a>
            <a href="/agents">Agents</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
