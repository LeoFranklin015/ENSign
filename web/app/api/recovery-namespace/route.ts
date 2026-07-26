import { NextResponse } from "next/server";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  fallback,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { namehash } from "viem/ens";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Provision the ENS namespace a guardian lives in.
 *
 * A guardian in ENSign is a *name*, not an address — `mom.recovery.leo.ensign.eth`.
 * Getting a three-level name means two registries: one hanging off the user's
 * own name to hold `recovery`, and one hanging off `recovery` to hold the
 * guardians themselves. This mirrors script/RecoveryDemo.s.sol exactly.
 *
 * The platform pays for and owns both registries, so adding a guardian costs
 * the user nothing. Ownership of the registries grants no power over the
 * account: the recovery manager only ever reads `ownerOf` on the guardian's
 * name, and the account itself is what points its name at the namespace — a
 * step only the account's passkey can authorise, which is why it comes back
 * to the client rather than happening here.
 */

const ZERO: Address = "0x0000000000000000000000000000000000000000";
/// Canonical PermissionedResolver implementation. Registering a name with no
/// resolver leaves it invisible: the indexer only follows names whose resolver
/// is a proxy of this allowlisted implementation, which is why every name here
/// gets one — the same way ENSignRegistry mints the top-level names.
const RESOLVER_IMPL: Address = "0xdcE5205A553573FFd47629327DDdf36186022FfA";
const STORAGE_REGISTRY: Address = "0x674cBe3246596871f18B2fe3489E09D77734fE06";
const USER_REGISTRY_IMPL: Address = "0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917";
const VERIFIABLE_FACTORY: Address = "0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198";

/// One bit per role slot — the registry owner needs all of them to register.
const ALL_ROLES = BigInt(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);

const registryAbi = parseAbi([
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function setResolver(uint256 anyId, address resolver)",
  "function getTokenId(uint256 anyId) view returns (uint256)",
  "function getResource(uint256 anyId) view returns (uint256)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
]);

const userRegistryAbi = parseAbi([
  "function initialize(address owner, uint256 roleBitmap)",
]);

const resolverAbi = parseAbi([
  "function initialize(address admin, uint256 roleBitmap)",
  "function setAddr(bytes32 node, uint256 coinType, bytes value)",
]);

/**
 * Explicit gas limits, deliberately generous.
 *
 * These transactions are broadcast together without waiting, so a call that
 * depends on a contract deployed one nonce earlier would be estimated against
 * state where that contract has no code — coming back at ~21k and running out
 * mid-execution. Measured usage is ~176k for a deploy and ~70k for a register;
 * unused gas is refunded, so headroom costs nothing.
 */
const GAS = {
  deploy: 500_000n,
  register: 400_000n,
  setAddr: 250_000n,
  setResolver: 200_000n,
} as const;

const labelId = (label: string) => BigInt(keccak256(toHex(label)));

export async function POST(req: Request) {
  try {
    const PK = process.env.BOT_PRIVATE_KEY as Hex | undefined;
    if (!PK) {
      return NextResponse.json({ error: "BOT_PRIVATE_KEY not set" }, { status: 500 });
    }

    const { label, account, guardianLabel, guardianAddress } = (await req.json()) as {
      label?: string;
      account?: Address;
      guardianLabel?: string;
      guardianAddress?: Address;
    };
    if (!label || !account) {
      return NextResponse.json({ error: "label and account are required" }, { status: 400 });
    }
    // Guardian details are optional: turning recovery on provisions the
    // namespace by itself, so `recovery.<you>.ensign.eth` exists before there
    // is anyone to put under it.
    const withGuardian = Boolean(guardianLabel || guardianAddress);
    if (withGuardian && !(guardianLabel && guardianAddress)) {
      return NextResponse.json(
        { error: "guardianLabel and guardianAddress must be given together" },
        { status: 400 },
      );
    }
    // Labels become DNS-ish names; keep them boring so nothing downstream has
    // to guess at normalisation.
    if (withGuardian && !/^[a-z0-9-]{1,63}$/.test(guardianLabel as string)) {
      return NextResponse.json(
        { error: "guardianLabel must be lowercase letters, digits or hyphens" },
        { status: 400 },
      );
    }

    const transport = fallback(
      [
        process.env.SEPOLIA_RPC_URL,
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://sepolia.drpc.org",
      ]
        .filter(Boolean)
        .map((u) => http(u as string, { timeout: 20_000, retryCount: 2 })),
      { rank: false },
    );
    // Unique per request: see deployRegistry for why the salt must not be
    // derived from the label alone.
    const saltSeed = keccak256(toHex(`${label}:${Date.now()}:${Math.random()}`));
    const bot = privateKeyToAccount(PK);
    const pub = createPublicClient({ chain: sepolia, transport });
    const wallet = createWalletClient({ account: bot, chain: sepolia, transport });

    const read = <T,>(address: Address, functionName: string, args: unknown[]) =>
      pub.readContract({ address, abi: registryAbi, functionName, args } as never) as Promise<T>;

    // The user's own name has to exist before it can have a namespace under it.
    const userTokenId = await read<bigint>(STORAGE_REGISTRY, "getTokenId", [labelId(label)]);
    const owner = await read<Address>(STORAGE_REGISTRY, "ownerOf", [userTokenId]);
    if (owner.toLowerCase() !== account.toLowerCase()) {
      return NextResponse.json(
        { error: `${label} is owned by ${owner}, not ${account}` },
        { status: 400 },
      );
    }
    // Guardian names must not outlive the name they hang off.
    const expiry = await read<bigint>(STORAGE_REGISTRY, "getExpiry", [userTokenId]);

    const parent = process.env.NEXT_PUBLIC_PARENT_NAME ?? "ensign.eth";
    const recoveryName = `recovery.${label}.${parent}`;

    /**
     * Send transactions concurrently.
     *
     * Every hop here costs a block, so doing five of them in series put ~70s in
     * front of the passkey prompt. Only genuinely dependent steps are ordered
     * now; the rest go out together under explicit sequential nonces, because
     * viem's automatic nonce would hand the same one to parallel sends.
     */
    let nonce = await pub.getTransactionCount({ address: bot.address, blockTag: "pending" });
    const sent: Hex[] = [];
    /**
     * Broadcast without waiting for receipts.
     *
     * Waiting cost a block per hop and put ~60s in front of the passkey prompt.
     * Nothing here needs a receipt: proxy addresses come from simulation, and
     * the resource id is derived off-chain. Explicit sequential nonces both let
     * these go out together and guarantee execution order, so a register that
     * depends on a deploy still sees it even in the same block.
     */
    const sendMany = async (txs: Array<{ to: Address; data: Hex; gas: bigint }>) => {
      const hashes = await Promise.all(
        txs.map((t) => wallet.sendTransaction({ ...t, nonce: nonce++ })),
      );
      sent.push(...hashes);
      return hashes;
    };
    const send = (to: Address, data: Hex, gas: bigint) => sendMany([{ to, data, gas }]);

    /**
     * Build (not send) a proxy deployment, returning the address it will land at.
     *
     * The address comes from simulating the call, so callers can wire it into
     * other transactions and fire the whole set concurrently. Salts carry a
     * per-request seed: provisioning ends with a userOp the client may never
     * send, so a label-derived salt would make a retry collide with the
     * registries the previous attempt left behind, and CREATE2 reverts on an
     * occupied address.
     */
    const proxyTx = async (tag: string, impl: Address, initAbi: Abi) => {
      const salt = BigInt(keccak256(toHex(`ensign:${tag}:${label}:${saltSeed}`)));
      const data = encodeFunctionData({
        abi: initAbi, functionName: "initialize", args: [bot.address, ALL_ROLES],
      } as never);
      const args = [impl, salt, data] as const;
      const { result } = await pub.simulateContract({
        account: bot, address: VERIFIABLE_FACTORY, abi: factoryAbi,
        functionName: "deployProxy", args,
      });
      return {
        address: result as Address,
        tx: {
          to: VERIFIABLE_FACTORY,
          data: encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args }),
          gas: GAS.deploy,
        },
      };
    };
    const registryTx = (tag: string) => proxyTx(tag, USER_REGISTRY_IMPL, userRegistryAbi);
    const resolverTx = (tag: string) => proxyTx(tag, RESOLVER_IMPL, resolverAbi);
    /// coinType 60 = SLIP-44 ETH, matching ENSignRegistry.
    const setAddrTx = (resolver: Address, name: string, target: Address) => ({
      to: resolver,
      data: encodeFunctionData({
        abi: resolverAbi, functionName: "setAddr", args: [namehash(name), 60n, target],
      }),
      gas: GAS.setAddr,
    });
    const registerTx = (
      registry: Address, lbl: string, owner: Address, sub: Address, resolver: Address,
    ) => ({
      to: registry,
      data: encodeFunctionData({
        abi: registryAbi, functionName: "register",
        args: [lbl, owner, sub, resolver, ALL_ROLES, expiry],
      }),
      gas: GAS.register,
    });



    // Already provisioned? The user's name points at its namespace registry,
    // and `recovery` inside that points at the one holding guardians. Reading
    // it back beats tracking state we'd only have to keep in sync.
    let namespaceRegistry = await read<Address>(STORAGE_REGISTRY, "getSubregistry", [label]);
    let methodsRegistry: Address;
    let needsSetSubregistry = false;

    // One resolver serves the whole namespace: PermissionedResolver keys records
    // by node, so `recovery` and every guardian can share it. ENSignRegistry
    // deploys one per name; here that would be an extra block per guardian.
    // Guard the read: on a first-time account the namespace does not exist yet,
    // and calling into the zero address returns "0x" rather than an address.
    let sharedResolver =
      namespaceRegistry === ZERO
        ? ZERO
        : await read<Address>(namespaceRegistry, "getResolver", ["recovery"]);

    if (namespaceRegistry === ZERO) {
      const [ns, methods, res] = await Promise.all([
        registryTx("rec-namespace"), registryTx("rec-methods"), resolverTx("rec-resolver"),
      ]);
      await sendMany([ns.tx, methods.tx, res.tx]);           // independent
      namespaceRegistry = ns.address;
      methodsRegistry = methods.address;
      sharedResolver = res.address;
      await sendMany([                                        // both need the above
        registerTx(namespaceRegistry, "recovery", account, methodsRegistry, sharedResolver),
        setAddrTx(sharedResolver, recoveryName, account),
      ]);
      needsSetSubregistry = true; // only the account can re-point its own name
    } else {
      methodsRegistry = await read<Address>(namespaceRegistry, "getSubregistry", ["recovery"]);
      if (methodsRegistry === ZERO || sharedResolver === ZERO) {
        // A namespace built before names carried resolvers is invisible to the
        // indexer. Retrofit rather than leaving those accounts stranded.
        const parts: Array<{ to: Address; data: Hex; gas: bigint }> = [];
        if (sharedResolver === ZERO) {
          const res = await resolverTx("rec-resolver");
          await sendMany([res.tx]);
          sharedResolver = res.address;
          const recoveryTokenId = await read<bigint>(namespaceRegistry, "getTokenId", [
            labelId("recovery"),
          ]);
          parts.push({
            to: namespaceRegistry,
            data: encodeFunctionData({
              abi: registryAbi, functionName: "setResolver",
              args: [recoveryTokenId, sharedResolver],
            }),
            gas: GAS.setResolver,
          });
          parts.push(setAddrTx(sharedResolver, recoveryName, account));
        }
        if (methodsRegistry === ZERO) {
          const methods = await registryTx("rec-methods");
          await sendMany([methods.tx]);
          methodsRegistry = methods.address;
          parts.push(
            registerTx(namespaceRegistry, "recovery", account, methodsRegistry, sharedResolver),
          );
        }
        if (parts.length) await sendMany(parts);
      }
    }

    if (!withGuardian) {
      return NextResponse.json({
        namespaceRegistry,
        methodsRegistry,
        userTokenId: userTokenId.toString(),
        needsSetSubregistry,
        storageRegistry: STORAGE_REGISTRY,
        txs: sent,
        resource: null,
        guardianName: null,
        recoveryName,
      });
    }

    // The guardian itself: mom.recovery.<label>.ensign.eth, owned by the
    // guardian's wallet so the manager's live `ownerOf` resolves to them.
    // Register and record-write are independent — register only stores the
    // resolver address, it does not call into it.
    const guardianName = `${guardianLabel}.${recoveryName}`;
    const taken = await read<Address>(methodsRegistry, "ownerOf", [
      await read<bigint>(methodsRegistry, "getTokenId", [labelId(guardianLabel as string)]),
    ]);
    if (taken !== ZERO) {
      return NextResponse.json(
        { error: `"${guardianLabel}" is already a guardian on this account` },
        { status: 409 },
      );
    }
    await sendMany([
      registerTx(methodsRegistry, guardianLabel as string, guardianAddress as Address,
                 ZERO, sharedResolver),
      setAddrTx(sharedResolver, guardianName, guardianAddress as Address),
    ]);

    // Resource = labelhash with the low 32 bits (the version) cleared. Reading
    // it back would mean waiting for the register to mine; this is the same
    // value the registry constructs for a freshly registered name.
    const resource = BigInt(keccak256(toHex(guardianLabel as string))) & ~((1n << 32n) - 1n);

    return NextResponse.json({
      namespaceRegistry,
      methodsRegistry,
      resource: resource.toString(),
      userTokenId: userTokenId.toString(),
      needsSetSubregistry,
      storageRegistry: STORAGE_REGISTRY,
      txs: sent,
      guardianName,
      recoveryName,
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 400 },
    );
  }
}
