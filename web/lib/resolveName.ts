/**
 * Direct ENSv2 name resolver — walks the registry chain by hand instead of
 * going through the (currently broken on Sepolia v2 staging) Universal Resolver.
 *
 * Usage:
 *   const c = createPublicClient({ chain: sepolia, transport: http(...) });
 *   const addr = await resolveAddr("2.sugh101.eth", { client: c });
 *   const profile = await resolveProfile("leo.looooo.eth", { client: c });
 *
 * Why this exists: the canonical v2 staging UR routes through a CCIP gateway
 * whose on-chain proof verifier currently reverts for every v2 name (verified
 * across `looooo.eth` and `sugh101.eth`). Direct getSubregistry/getResolver
 * walks return correct data with no CCIP and no proof step.
 */

import {
  namehash,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/// Default root registry — ENSv2 staging `.eth` on Sepolia.
export const SEPOLIA_V2_ETH_REGISTRY: Address =
  "0xF332544e6234f1CA149907D0d4658afD5feB6831";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const registryAbi = parseAbi([
  "function getSubregistry(string) view returns (address)",
  "function getResolver(string) view returns (address)",
]);

const resolverAbi = parseAbi([
  "function addr(bytes32) view returns (address)",
  "function addr(bytes32, uint256) view returns (bytes)",
  "function text(bytes32, string) view returns (string)",
]);

export type ResolveContext = {
  client: PublicClient;
  /// Defaults to {@link SEPOLIA_V2_ETH_REGISTRY}.
  rootRegistry?: Address;
};

export type RegistryWalk = {
  /// The registry that holds the leaf label.
  registry: Address;
  /// The resolver pointer for the leaf.
  resolver: Address;
  /// namehash of the full ENS name.
  node: Hex;
};

/**
 * Walks from the root registry through subregistries down to the registry
 * that holds the leaf label. Returns null if any link is missing (no
 * subregistry, no resolver pointer).
 */
export async function walkRegistry(
  name: string,
  ctx: ResolveContext,
): Promise<RegistryWalk | null> {
  const labels = name.split(".");
  if (labels[labels.length - 1] !== "eth") {
    throw new Error('only ".eth" names are supported');
  }

  let current = ctx.rootRegistry ?? SEPOLIA_V2_ETH_REGISTRY;

  // Walk from second-to-last label (e.g., "looooo") down to index 1.
  // For "bot.leo.looooo.eth" → labels = ["bot","leo","looooo","eth"] →
  //   walk "looooo", then "leo", landing in the registry that holds "bot".
  for (let i = labels.length - 2; i > 0; i--) {
    const label = labels[i];
    const next = (await ctx.client.readContract({
      address: current,
      abi: registryAbi,
      functionName: "getSubregistry",
      args: [label],
    })) as Address;
    if (next === ZERO) return null;
    current = next;
  }

  const leaf = labels[0];
  const resolver = (await ctx.client.readContract({
    address: current,
    abi: registryAbi,
    functionName: "getResolver",
    args: [leaf],
  })) as Address;
  if (resolver === ZERO) return null;

  return { registry: current, resolver, node: namehash(name) };
}

/**
 * Resolve `addr(name)` → ETH address. Returns null if no resolver/record.
 */
export async function resolveAddr(
  name: string,
  ctx: ResolveContext,
): Promise<Address | null> {
  const w = await walkRegistry(name, ctx);
  if (!w) return null;
  try {
    const a = (await ctx.client.readContract({
      address: w.resolver,
      abi: resolverAbi,
      functionName: "addr",
      args: [w.node],
    })) as Address;
    return a === ZERO ? null : a;
  } catch {
    return null;
  }
}

/**
 * Resolve `addr(name, coinType)` → raw bytes. Useful for multi-coin records
 * (e.g., coinType `60` = ETH, `8453` = Base, `614` = Optimism).
 */
export async function resolveAddrCoin(
  name: string,
  coinType: number,
  ctx: ResolveContext,
): Promise<Hex | null> {
  const w = await walkRegistry(name, ctx);
  if (!w) return null;
  try {
    const data = (await ctx.client.readContract({
      address: w.resolver,
      abi: resolverAbi,
      functionName: "addr",
      args: [w.node, BigInt(coinType)],
    })) as Hex;
    return !data || data === "0x" ? null : data;
  } catch {
    return null;
  }
}

/**
 * Resolve `text(name, key)` → string. Returns null if no resolver/record.
 */
export async function resolveText(
  name: string,
  key: string,
  ctx: ResolveContext,
): Promise<string | null> {
  const w = await walkRegistry(name, ctx);
  if (!w) return null;
  try {
    const v = (await ctx.client.readContract({
      address: w.resolver,
      abi: resolverAbi,
      functionName: "text",
      args: [w.node, key],
    })) as string;
    return v || null;
  } catch {
    return null;
  }
}

/// Common ENSIP-5 profile keys.
export const PROFILE_KEYS = [
  "name",
  "avatar",
  "description",
  "url",
  "email",
  "com.twitter",
  "com.github",
  "org.telegram",
] as const;

export type Profile = {
  registry: Address;
  resolver: Address;
  node: Hex;
  addr: Address | null;
  text: Record<string, string | null>;
};

/**
 * Pull addr + the standard ENS profile text records in one go. All field
 * fetches happen in parallel after the registry walk.
 */
export async function resolveProfile(
  name: string,
  ctx: ResolveContext,
  keys: readonly string[] = PROFILE_KEYS,
): Promise<Profile | null> {
  const w = await walkRegistry(name, ctx);
  if (!w) return null;

  const reads: Promise<unknown>[] = [
    ctx.client
      .readContract({
        address: w.resolver,
        abi: resolverAbi,
        functionName: "addr",
        args: [w.node],
      })
      .then((a) => ((a as Address) === ZERO ? null : (a as Address)))
      .catch(() => null),
    ...keys.map((k) =>
      ctx.client
        .readContract({
          address: w.resolver,
          abi: resolverAbi,
          functionName: "text",
          args: [w.node, k],
        })
        .then((v) => (v as string) || null)
        .catch(() => null),
    ),
  ];

  const [addr, ...textValues] = await Promise.all(reads);
  const text: Record<string, string | null> = {};
  keys.forEach((k, i) => (text[k] = textValues[i] as string | null));

  return {
    registry: w.registry,
    resolver: w.resolver,
    node: w.node,
    addr: addr as Address | null,
    text,
  };
}
