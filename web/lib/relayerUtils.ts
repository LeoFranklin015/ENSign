/**
 * Shared, initialise-once handle on zkEmail's relayer-utils WASM module.
 *
 * The module is wasm-bindgen: it must be instantiated before any call, but
 * calling `init()` a second time corrupts its state — the first request after
 * a restart succeeds and every later one fails with "Failed to parse
 * AccountCode" or "__wbindgen_malloc is undefined". Caching the promise keeps
 * exactly one instantiation per process and makes concurrent callers wait on
 * the same one.
 */

type RelayerUtils = typeof import("@zk-email/relayer-utils");

let ready: Promise<RelayerUtils> | null = null;

export function relayerUtils(): Promise<RelayerUtils> {
  if (!ready) {
    ready = (async () => {
      const utils = await import("@zk-email/relayer-utils");
      await utils.init();
      return utils;
    })().catch((e) => {
      // Don't cache a failed init — let the next request retry.
      ready = null;
      throw e;
    });
  }
  return ready;
}
