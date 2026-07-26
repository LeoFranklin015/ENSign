"use client";

/// Generates a self-contained `javascript:` bookmarklet. The entire connector
/// code is **inlined** so the bookmarklet doesn't trigger a `script-src` CSP
/// violation on dApps with strict CSP (Aave, ENS app, etc).
///
/// Bookmarklet URLs themselves bypass `script-src` because they're treated as
/// user-initiated. But anything they then *load* externally (like fetching
/// `/connector.js`) gets blocked by CSP. So we ship the code inside the URL.
import { useEffect, useMemo, useState } from "react";
import { BookmarkletLink } from "@/components/BookmarkletLink";

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
    <div className="bookmarklet-hero">
      <BookmarkletLink
        href={bookmarklet}
        className="bookmarklet bookmarklet-big"
        draggable={ready}
        aria-disabled={!ready}
        style={ready ? undefined : { opacity: 0.5, cursor: "wait" }}
      >
        {ready ? "ENSign" : "loading…"}
      </BookmarkletLink>
      <span className="muted small bookmarklet-hint">
        {ready ? "drag this to your bookmarks bar ↗" : ""}
      </span>
      <button className="ghost bookmarklet-copy" onClick={copyCode} disabled={!ready}>
        {copied ? "copied" : "copy code"}
      </button>

      {fetchError && (
        <div className="err small">
          Couldn't load <code>/connector.js</code>: {fetchError}.
        </div>
      )}

      <details className="muted small bookmarklet-details">
        <summary>can't see your bookmarks bar?</summary>
        <p>
          Chrome / Firefox: <code>⌘+Shift+B</code>. Safari: View → Show Favorites Bar. Or "copy
          code" and paste it as the URL of a new bookmark.
        </p>
      </details>
    </div>
  );
}