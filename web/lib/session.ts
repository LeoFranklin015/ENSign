/**
 * Tiny session store — remembers the connected ENSign name in localStorage.
 * Source of truth is still ENS state on-chain; this is just so the dashboard
 * knows which label to resolve on mount.
 */

const KEY_LABEL = "ensign:label";
const KEY_ACCOUNT = "ensign:account";
const KEY_CRED_ID = "ensign:credentialId";

export type Session = {
  label: string;
  fullName: string;
  account: `0x${string}`;
  credentialId: string;
};

export function saveSession(s: Session) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY_LABEL, s.label);
  localStorage.setItem(KEY_ACCOUNT, s.account);
  localStorage.setItem(KEY_CRED_ID, s.credentialId);
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const label = localStorage.getItem(KEY_LABEL);
  const account = localStorage.getItem(KEY_ACCOUNT) as `0x${string}` | null;
  const credentialId = localStorage.getItem(KEY_CRED_ID);
  if (!label || !account || !credentialId) return null;
  // Note: PARENT_NAME is read at usage site to avoid coupling.
  return { label, fullName: "", account, credentialId };
}

export function clearSession() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY_LABEL);
  localStorage.removeItem(KEY_ACCOUNT);
  localStorage.removeItem(KEY_CRED_ID);
}
