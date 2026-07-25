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
import "../app/app.css";
import { Nav } from "@/components/Nav";
import { getSession } from "@/lib/session";
import {
  CHAIN,
  CHAIN_ID,
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

/** zkEmail's relayer derives accountSalt = Poseidon(emailAddress, accountCode). */
async function deriveAccountSalt(emailAddress: string, accountCode: Hex): Promise<Hex> {
  if (accountCode.length !== 66) {
    throw new Error(`account code must be 32 bytes, got ${(accountCode.length - 2) / 2}`);
  }
  let res: Response;
  try {
    res = await fetch("https://relayer.zk.email/api/accountSalt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailAddress, accountCode }),
    });
  } catch (e) {
    throw new Error(`could not reach zkEmail relayer: ${(e as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`relayer ${res.status}: ${body.slice(0, 160)}`);
  let json: { accountSalt?: string };
  try {
    json = JSON.parse(body) as { accountSalt?: string };
  } catch {
    throw new Error(`relayer returned non-JSON: ${body.slice(0, 160)}`);
  }
  if (!json.accountSalt) throw new Error("relayer returned no accountSalt");
  return json.accountSalt as Hex;
}

const zkProviderAbi = parseAbi([
  "function expectedCommand(address account, uint256 nonce, bytes subject) pure returns (string)",
  "function recoveryHash(address account, uint256 nonce, bytes subject) pure returns (bytes32)",
]);

/// zkEmail relayer. The hosted one at relayer.zk.email currently 404s on its
/// own prover backend, so point this at a self-hosted instance to complete the
/// email flow: NEXT_PUBLIC_ZKEMAIL_RELAYER=http://your-host:8000/api
const RELAYER = process.env.NEXT_PUBLIC_ZKEMAIL_RELAYER ?? "https://relayer.zk.email/api";

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

/// Ask the relayer to email the guardian. It returns a request id to poll.
async function relayerSubmit(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${RELAYER}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`relayer ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { id?: string };
  if (!json.id) throw new Error(`relayer returned no request id: ${text.slice(0, 160)}`);
  return json.id;
}

/// Poll until the guardian has replied and the proof has been generated.
/// The relayer hands the proof back rather than broadcasting it, which is what
/// lets our own provider verify it.
async function relayerStatus(id: string): Promise<{
  status: string;
  proof?: EmailProofJson;
}> {
  const res = await fetch(`${RELAYER}/status/${id}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`relayer ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as {
    request?: { status?: string };
    response?: { proof?: EmailProofJson } | null;
  };
  return {
    status: json.request?.status ?? "Unknown",
    proof: json.response?.proof,
  };
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
  const [delayMins, setDelayMins] = useState("0");
  const [thresholdInput, setThresholdInput] = useState("1");

  // email guardian
  const [guardianEmail, setGuardianEmail] = useState("");
  const [accountCode, setAccountCode] = useState<Hex | null>(null);
  const [emailProofJson, setEmailProofJson] = useState("");
  const [emailCommand, setEmailCommand] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailRequestId, setEmailRequestId] = useState<string | null>(null);

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

  const enableRecovery = () =>
    ownerCall("enable recovery",
      encodeFunctionData({ abi: accountAbi, functionName: "addOwnerAddress", args: [MANAGER] }),
      account!);

  const addEoaGuardian = () => {
    const g = guardianAddr.trim() as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(g)) { setErr("guardian must be a 0x address"); return; }
    const commitment = encodeAbiParameters([{ type: "address" }], [g]);
    const delay = Math.max(0, Math.floor(Number(delayMins) || 0)) * 60;
    return ownerCall(`add guardian ${short(g)}`,
      encodeFunctionData({
        abi: managerAbi, functionName: "addRecovery",
        args: [ECDSA_PROVIDER, commitment, delay],
      }), MANAGER);
  };

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
      if (ok) setNote(`email guardian registered — SAVE this account code: ${code}`);
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
        // Only used for the relayer's own DKIM bookkeeping; the proof itself is
        // chain-agnostic and we verify it against Sepolia's registry.
        chain: "baseSepolia",
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
  const emailGuardians = recoveries.filter(
    (r) => r.provider.toLowerCase() === ZKEMAIL_PROVIDER.toLowerCase(),
  );

  return (
    <>
      <Nav />
      <main className="ag-section">
        <div className="ag-kicker">recovery</div>
        <h2 className="ag-h2">Guardians for {label}</h2>
        <p className="ag-hint mono">
          manager {short(MANAGER)} · nonce {String(nonce)} · threshold {threshold}
        </p>

        {err && <div className="ag-error">{err}</div>}
        {note && <div className="ag-hint mono">{note}</div>}

        {/* ── 1. setup ─────────────────────────────────────────── */}
        <section className="ag-preview">
          <div className="ag-section-title">1 · Setup (as the account owner)</div>
          <div className="ag-preview-body">
            <div className="ag-row">
              <span className="ag-prelabel">opt-in</span>
              {optedIn ? (
                <span className="ag-hint mono">manager is an owner ✓</span>
              ) : (
                <button className="action" disabled={!!busy} onClick={enableRecovery}>
                  {busy === "enable recovery" ? "…" : "Enable recovery"}
                </button>
              )}
            </div>

            <div className="ag-field">
              <label className="ag-field-label">add guardian (EOA)</label>
              <div className="ag-row">
                <input
                  className="ag-input mono" placeholder="0x… guardian wallet"
                  value={guardianAddr} onChange={(e) => setGuardianAddr(e.target.value)}
                />
                <input
                  className="ag-input ag-input--num ag-input--inline" placeholder="delay"
                  value={delayMins} onChange={(e) => setDelayMins(e.target.value)}
                />
                <span className="ag-hint mono">min</span>
                <button className="action" disabled={!!busy || !optedIn} onClick={addEoaGuardian}>
                  Add
                </button>
              </div>
              <p className="ag-hint mono">
                Uses the ECDSA provider. ENS-name guardians are registered by the
                setup script (needs the namespace minted first).
              </p>
            </div>

            <div className="ag-field">
              <label className="ag-field-label">add guardian (email · zkEmail)</label>
              <div className="ag-row">
                <input
                  className="ag-input mono" placeholder="mom@gmail.com"
                  value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)}
                />
                <button
                  className="action" disabled={!!busy || !optedIn}
                  onClick={addEmailGuardian}
                >
                  {busy === "add email guardian" ? "…" : "Add email"}
                </button>
              </div>
              {accountCode && (
                <p className="ag-hint mono">
                  account code (save this — needed to prove later): {accountCode}
                </p>
              )}
              <p className="ag-hint mono">
                The address is never stored on-chain: the commitment is
                Poseidon(email, accountCode) derived via zkEmail&apos;s relayer.
              </p>
            </div>

            <div className="ag-field">
              <label className="ag-field-label">threshold</label>
              <div className="ag-row">
                <input
                  className="ag-input ag-input--num ag-input--inline"
                  value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)}
                />
                <span className="ag-hint mono">of {recoveries.length}</span>
                <button className="action" disabled={!!busy} onClick={applyThreshold}>Set</button>
              </div>
            </div>

            <div className="ag-exec-list">
              {recoveries.length === 0 && (
                <p className="ag-hint mono">no guardians yet</p>
              )}
              {recoveries.map((r, i) => (
                <div className="ag-exec-item" key={i}>
                  <div className="ag-exec-item-head">
                    <span className="ag-exec-idx">{i + 1}</span>
                    <span className="mono">{describeCommitment(r)}</span>
                  </div>
                  <div className="ag-exec-item-meta mono">
                    {PROVIDER_NAMES[r.provider.toLowerCase()] ?? short(r.provider)} · delay{" "}
                    {r.delay === 0 ? "none" : `${r.delay / 60}min`}
                    <button className="ag-ghost" disabled={!!busy} onClick={() => removeGuardian(r)}>
                      remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── 2. recover ───────────────────────────────────────── */}
        <section className="ag-preview">
          <div className="ag-section-title">2 · Recover (lost device)</div>
          <div className="ag-preview-body">
            <div className="ag-field">
              <label className="ag-field-label">account to recover</label>
              <input
                className="ag-input mono" value={targetAccount}
                onChange={(e) => setTargetAccount(e.target.value)}
              />
            </div>

            <div className="ag-row">
              <button className="action" disabled={!!busy} onClick={generateKey}>
                {busy === "create passkey" ? "…" : "1. Create new passkey"}
              </button>
              {newKey && <span className="ag-hint mono">qx {short(newKey.qx)}</span>}
            </div>

            <div className="ag-row">
              <button className="action" disabled={!!busy || !newKey} onClick={signAsGuardian}>
                {busy === "guardian signature" ? "…" : "2. Sign as guardian (wallet)"}
              </button>
              <span className="ag-hint mono">
                {sigs.length}/{threshold} signatures
              </span>
            </div>
            {sigs.map((s) => (
              <div className="ag-hint mono" key={s.recoveryId}>
                ✓ {s.signer.startsWith("email") ? s.signer : short(s.signer)}
              </div>
            ))}

            <div className="ag-field">
              <label className="ag-field-label">2b · approve by email (zkEmail)</label>

              {emailGuardians.length === 0 && (
                <p className="ag-hint mono">no email guardians registered</p>
              )}

              {emailGuardians.length > 0 && (
                <>
                  <div className="ag-row">
                    <input
                      className="ag-input mono"
                      placeholder="account code saved at registration (0x…64 hex)"
                      value={accountCode ?? ""}
                      onChange={(e) => setAccountCode(e.target.value.trim() as Hex)}
                    />
                  </div>
                  <div className="ag-row">
                    <input
                      className="ag-input mono" placeholder="guardian email"
                      value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)}
                    />
                    <button
                      className="action"
                      disabled={!!busy || !newKey || !accountCode}
                      onClick={() => requestEmailApproval(emailGuardians[0])}
                    >
                      {busy === "email approval" ? "waiting…" : "Send approval email"}
                    </button>
                  </div>
                  {/* Say why the button is disabled — otherwise it just looks broken. */}
                  {!newKey && (
                    <p className="ag-hint mono">
                      ⚠ click <strong>&ldquo;1. Create new passkey&rdquo;</strong> above first —
                      the email has to commit to a specific new key.
                    </p>
                  )}
                  {newKey && !accountCode && (
                    <p className="ag-hint mono">
                      ⚠ paste the account code you saved when registering this guardian.
                    </p>
                  )}
                  {newKey && accountCode && accountCode.length !== 66 && (
                    <p className="ag-hint mono">
                      ⚠ account code must be 32 bytes (0x + 64 hex), got{" "}
                      {(accountCode.length - 2) / 2} bytes.
                    </p>
                  )}
                </>
              )}

              {emailStatus && <p className="ag-hint mono">{emailStatus}</p>}
              {emailRequestId && (
                <p className="ag-hint mono">request {emailRequestId}</p>
              )}

              <details>
                <summary className="ag-hint mono">manual: paste a proof instead</summary>
                <div className="ag-row">
                  <button className="action" disabled={!!busy || !newKey} onClick={showEmailCommand}>
                    Show command
                  </button>
                </div>
                {emailCommand && (
                  <p className="ag-hint mono">
                    the email must authorize exactly:<br />
                    <strong>{emailCommand}</strong>
                  </p>
                )}
                <textarea
                  className="ag-input mono" rows={4}
                  placeholder='paste EmailProof JSON {"domainName":"gmail.com",…}'
                  value={emailProofJson} onChange={(e) => setEmailProofJson(e.target.value)}
                />
                <button
                  className="action" disabled={!!busy || !emailProofJson.trim()}
                  onClick={attachEmailProof}
                >
                  Attach email proof
                </button>
              </details>
            </div>

            <div className="ag-row">
              <button
                className="action"
                disabled={!!busy || sigs.length < threshold || !!requestId}
                onClick={submitRequest}
              >
                {busy === "submit request" ? "…" : "3. Submit request"}
              </button>
            </div>

            {requestId && (
              <div className="ag-exec-item">
                <div className="ag-exec-item-head">
                  <span className="mono">request {short(requestId)}</span>
                </div>
                <div className="ag-exec-when mono">
                  {ready ? "ready to execute" : `executable in ${executeAt - now}s`}
                </div>
                <div className="ag-modal-actions">
                  <button className="action" disabled={!!busy || !ready} onClick={executeRequest}>
                    4. Execute
                  </button>
                  <button className="ag-ghost" disabled={!!busy} onClick={cancelRequest}>
                    Cancel (veto, as owner)
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
