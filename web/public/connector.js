// ENSign injectable connector.
//
// Loaded by the bookmarklet onto any dApp page. It:
//   1. Mounts an iframe pointing at our `/embed` page (passkey-bearing origin).
//   2. Bridges postMessage between the iframe and a synthesized EIP-1193 provider.
//   3. Announces the provider via EIP-6963 and (if not yet defined) sets `window.ethereum`.
//
// The iframe controls its own visibility by postMessaging `show` events. The
// dApp doesn't have to know we're a smart account — it just sees a wallet that
// signs.
(function () {
  if (window.__justaconnectInjected) {
    console.info("[ENSign] already injected");
    return;
  }
  window.__justaconnectInjected = true;

  // Origin of our wallet web app. The bookmarklet can override via window.JUSTACONNECT_ORIGIN.
  const ORIGIN = window.JUSTACONNECT_ORIGIN || "http://localhost:5173";
  const EMBED_URL = ORIGIN + "/embed";

  // Backdrop sits behind a centred modal. Click outside = ask the iframe to close.
  const backdrop = document.createElement("div");
  backdrop.style.cssText = [
    "position:fixed",
    "inset:0",
    "background:rgba(15,15,17,0.55)",
    "backdrop-filter:blur(6px)",
    "-webkit-backdrop-filter:blur(6px)",
    "z-index:2147483646",
    "display:none",
    "opacity:0",
    "transition:opacity 180ms ease",
  ].join(";");
  document.body.appendChild(backdrop);

  const iframe = document.createElement("iframe");
  iframe.src = EMBED_URL;
  iframe.allow = "publickey-credentials-get *; publickey-credentials-create *; clipboard-read; clipboard-write";
  iframe.title = "ENSign";
  iframe.style.cssText = [
    "position:fixed",
    "top:50%",
    "left:50%",
    "transform:translate(-50%,-50%) scale(0.98)",
    "width:400px",
    "height:620px",
    "max-width:calc(100vw - 32px)",
    "max-height:calc(100vh - 32px)",
    "border:0",
    "border-radius:20px",
    "box-shadow:0 24px 64px -12px rgba(15,15,17,0.35), 0 4px 16px rgba(15,15,17,0.12), 0 0 0 1px rgba(15,15,17,0.06)",
    "z-index:2147483647",
    "display:none",
    "opacity:0",
    "background:#fafaf7",
    "color-scheme:light",
    "transition:opacity 220ms ease, transform 220ms cubic-bezier(0.2,0.8,0.2,1)",
  ].join(";");
  document.body.appendChild(iframe);

  function setShellVisible(visible) {
    if (visible) {
      backdrop.style.display = "block";
      iframe.style.display = "block";
      // Force reflow so the transition runs
      void iframe.offsetWidth;
      backdrop.style.opacity = "1";
      iframe.style.opacity = "1";
      iframe.style.transform = "translate(-50%,-50%) scale(1)";
    } else {
      backdrop.style.opacity = "0";
      iframe.style.opacity = "0";
      iframe.style.transform = "translate(-50%,-50%) scale(0.98)";
      setTimeout(() => {
        backdrop.style.display = "none";
        iframe.style.display = "none";
      }, 200);
    }
  }

  // Backdrop click → ask iframe to close gracefully (it can reject any pending request first).
  backdrop.addEventListener("click", () => {
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage({ kind: "close-request" }, "*");
    }
  });

  // ---------------- postMessage RPC bridge ----------------

  let nextId = 1;
  const pending = new Map();
  const listeners = { accountsChanged: [], chainChanged: [], connect: [], disconnect: [] };
  let hasConnected = false;

  // Iframe readiness gate — RPCs queued before the embed mounts its listener
  // would otherwise be dropped (first-click race). We buffer until the iframe
  // posts back `{kind:"ready"}` and then flush.
  let iframeReady = false;
  const readyWaiters = [];
  function waitReady() {
    if (iframeReady) return Promise.resolve();
    return new Promise((resolve) => readyWaiters.push(resolve));
  }
  function markReady() {
    if (iframeReady) return;
    iframeReady = true;
    while (readyWaiters.length) readyWaiters.shift()();
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.warn("[ENSign] listener error", e); }
    });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow) return;
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "show") {
      setShellVisible(!!msg.visible);
    } else if (msg.kind === "rpc-result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || "RPC error"), msg.error));
      else p.resolve(msg.result);
    } else if (msg.kind === "event") {
      if (msg.event === "accountsChanged") {
        const accounts = Array.isArray(msg.payload) ? msg.payload : [];
        provider.selectedAddress = accounts[0] || null;
        if (accounts.length > 0 && !hasConnected) {
          hasConnected = true;
          emit("connect", { chainId: provider.chainId || "0xaa36a7" });
        }
      } else if (msg.event === "chainChanged") {
        provider.chainId = msg.payload;
      }
      emit(msg.event, msg.payload);
    } else if (msg.kind === "ready") {
      markReady();
    }
  });

  function sendRpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      waitReady().then(() => {
        iframe.contentWindow.postMessage(
          { kind: "rpc", id, method, params: params || [] },
          ORIGIN,
        );
      });
    });
  }

  // ---------------- EIP-1193 provider ----------------

  const provider = {
    isENSign: true,
    chainId: "0xaa36a7",
    selectedAddress: null,
    request: (argsOrMethod, maybeParams) => {
      // Tolerate non-spec callers using request(method, params)
      if (typeof argsOrMethod === "string") {
        return sendRpc(argsOrMethod, maybeParams);
      }
      const args = argsOrMethod || {};
      return sendRpc(args.method, args.params);
    },
    on: (event, fn) => {
      (listeners[event] = listeners[event] || []).push(fn);
      return provider;
    },
    addListener: (event, fn) => {
      (listeners[event] = listeners[event] || []).push(fn);
      return provider;
    },
    once: (event, fn) => {
      const wrapped = (payload) => {
        provider.removeListener(event, wrapped);
        fn(payload);
      };
      (listeners[event] = listeners[event] || []).push(wrapped);
      return provider;
    },
    removeListener: (event, fn) => {
      listeners[event] = (listeners[event] || []).filter((x) => x !== fn);
      return provider;
    },
    removeAllListeners: (event) => {
      if (event) listeners[event] = [];
      else Object.keys(listeners).forEach((k) => { listeners[k] = []; });
      return provider;
    },
    off: (event, fn) => {
      listeners[event] = (listeners[event] || []).filter((x) => x !== fn);
      return provider;
    },
    listenerCount: (event) => (listeners[event] || []).length,
    isConnected: () => !!provider.selectedAddress,
    _metamask: {
      isUnlocked: async () => true,
    },
    // legacy compatibility
    enable: () => sendRpc("eth_requestAccounts", []),
    sendAsync: (req, cb) =>
      sendRpc(req.method, req.params).then(
        (r) => cb(null, { id: req.id, jsonrpc: "2.0", result: r }),
        (e) => cb(e),
      ),
    send: (method, params) => sendRpc(method, params),
  };

  // ---------------- EIP-6963 announce ----------------

  const info = {
    uuid: "justaconnect-" + Math.random().toString(36).slice(2),
    name: "ENSign",
    icon:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' rx='24' fill='%230b0d10'/%3E%3Ccircle cx='60' cy='60' r='30' fill='%2300d084'/%3E%3C/svg%3E",
    rdns: "id.justaconnect",
  };
  function announce() {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
    );
  }
  announce();
  window.addEventListener("eip6963:requestProvider", announce);

  // ---------------- Legacy window.ethereum ----------------

  if (!window.ethereum) {
    try {
      Object.defineProperty(window, "ethereum", {
        value: provider,
        configurable: true,
        writable: false,
      });
    } catch (e) {
      window.ethereum = provider;
    }
  } else {
    // Some dApps freeze window.ethereum; we still get picked up via EIP-6963.
    console.info("[ENSign] window.ethereum already set; relying on EIP-6963");
  }

  console.info("[ENSign] injected. Connect via dApp's wallet picker.");
})();
