/// Generates a self-contained `javascript:` bookmarklet. The entire connector
/// code is **inlined** so the bookmarklet doesn't trigger a `script-src` CSP
/// violation on dApps with strict CSP (Aave, ENS app, etc).
///
/// Bookmarklet URLs themselves bypass `script-src` because they're treated as
/// user-initiated. But anything they then *load* externally (like fetching
/// `/connector.js`) gets blocked by CSP. So we ship the code inside the URL.
import { useEffect, useMemo, useRef, useState } from "react";

export function BookmarkletCard() {
  const origin = window.location.origin;

  // Fetch the connector source on mount so the bookmarklet contains the full
  // code inline. ~5KB of JS → ~8KB URL-encoded → well within bookmark limits.
  const [connectorCode, setConnectorCode] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${origin}/connector.js`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then(setConnectorCode)
      .catch((e) => setFetchError(String(e?.message ?? e)));
  }, [origin]);

  const bookmarklet = useMemo(() => {
    if (!connectorCode) return "javascript:void(0)";
    // Wrap the connector in an outer IIFE that pre-sets the origin override.
    // The connector itself is already wrapped in `(function(){…})()` so dropping
    // it inline runs cleanly.
    const wrapped =
      "(function(){window.JUSTACONNECT_ORIGIN=" +
      JSON.stringify(origin) +
      ";\n" +
      connectorCode +
      "\n})();";
    return "javascript:" + encodeURIComponent(wrapped);
  }, [origin, connectorCode]);

  // React 19 strips `href="javascript:..."` as a security measure. Set the
  // attribute imperatively so the bookmark drag picks up the literal URL.
  const linkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (linkRef.current) {
      linkRef.current.setAttribute("href", bookmarklet);
    }
  }, [bookmarklet]);

  const [copied, setCopied] = useState(false);
  function copyCode() {
    navigator.clipboard
      .writeText(bookmarklet)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  const ready = !!connectorCode;

  return (
    <section className="card">
      <h2>Use on any dApp (bookmarklet)</h2>
      <p className="muted">
        For dApps that don't speak WalletConnect: drag the link below to your bookmarks bar, then
        click it on any dApp tab. ENSign appears in the dApp's wallet picker, and Face ID
        prompts run in a corner iframe served from this same origin.
      </p>
      <p className="muted small">
        The connector is inlined into the bookmarklet so it works on dApps with strict CSP (Aave,
        ENS app, etc.).
      </p>

      <div className="bookmarklet-box">
        <a
          ref={linkRef}
          className="bookmarklet"
          draggable={ready}
          aria-disabled={!ready}
          style={ready ? undefined : { opacity: 0.5, cursor: "wait" }}
        >
          🔖 {ready ? "Use ENSign" : "Loading…"}
        </a>
        <span className="muted small">← drag this to your bookmarks bar</span>
        <button className="ghost" onClick={copyCode} disabled={!ready}>
          {copied ? "Copied!" : "Copy code"}
        </button>
      </div>

      {fetchError && (
        <div className="err small">
          Couldn't load <code>/connector.js</code>: {fetchError}. Make sure the dev server is
          running.
        </div>
      )}

      <details className="muted small">
        <summary>If your browser hides the bookmarks bar</summary>
        <ol>
          <li>
            Show it: Chrome <code>⌘+Shift+B</code>, Safari View → Show Favorites Bar, Firefox{" "}
            <code>⌘+Shift+B</code>.
          </li>
          <li>Drag the green "Use ENSign" button onto the bar.</li>
          <li>Or: click "Copy code", create a new bookmark anywhere, paste as the URL.</li>
        </ol>
      </details>

      <details className="muted small">
        <summary>How it works</summary>
        <ol>
          <li>Click bookmarklet on a dApp tab.</li>
          <li>Inlined connector runs in the dApp page (CSP-safe — no external script load).</li>
          <li>
            Connector mounts an iframe (<code>{origin}/embed</code>) — frame load not gated by{" "}
            <code>script-src</code>.
          </li>
          <li>Connector announces an EIP-1193 provider via EIP-6963.</li>
          <li>dApp's wallet picker lists ENSign.</li>
          <li>Approve as a name → Face ID for each tx, no tab switching.</li>
        </ol>
      </details>
    </section>
  );
}
