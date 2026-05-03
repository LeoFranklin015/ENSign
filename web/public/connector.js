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

  // ENS lozenge in lime, inside a dark rounded tile.
  // Build the data URI at runtime so the source stays readable.
  const ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">' +
    '<rect width="24" height="24" rx="5" fill="#131418"/>' +
    '<rect x="3" y="3" width="18" height="18" rx="3" stroke="#8b8e94" stroke-width="1.6"/>' +
    '<g transform="translate(5 4.5) scale(0.0693 0.0649)" fill="#b8ff3a">' +
      '<path d="M98.3592 2.80337L34.8353 107.327C34.3371 108.147 33.1797 108.238 32.5617 107.505C26.9693 100.864 6.13478 72.615 31.9154 46.8673C55.4403 23.3726 85.4045 6.62129 96.5096 0.831705C97.7695 0.174847 99.0966 1.59007 98.3592 2.80337Z"/>' +
      '<path d="M94.8459 230.385C96.1137 231.273 97.6758 229.759 96.8261 228.467C82.6374 206.886 35.4713 135.081 28.9559 124.302C22.5295 113.67 9.88976 96.001 8.83534 80.8842C8.7301 79.3751 6.64332 79.0687 6.11838 80.4879C5.27178 82.7767 4.37045 85.5085 3.53042 88.6292C-7.07427 128.023 8.32698 169.826 41.7753 193.238L94.8459 230.386V230.385Z"/>' +
      '<path d="M103.571 228.526L167.095 124.003C167.593 123.183 168.751 123.092 169.369 123.825C174.961 130.465 195.796 158.715 170.015 184.463C146.49 207.957 116.526 224.709 105.421 230.498C104.161 231.155 102.834 229.74 103.571 228.526Z"/>' +
      '<path d="M107.154 0.930762C105.886 0.0433954 104.324 1.5567 105.174 2.84902C119.363 24.4301 166.529 96.2354 173.044 107.014C179.471 117.646 192.11 135.315 193.165 150.432C193.27 151.941 195.357 152.247 195.882 150.828C196.728 148.539 197.63 145.808 198.47 142.687C209.074 103.293 193.673 61.4905 160.225 38.078L107.154 0.930762Z"/>' +
    '</g></svg>';

  const info = {
    uuid: "ensign-" + Math.random().toString(36).slice(2),
    name: "ENSign",
    icon: "data:image/svg+xml," + encodeURIComponent(ICON_SVG),
    rdns: "id.ensign",
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
