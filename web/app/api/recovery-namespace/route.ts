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

    const send = async (to: Address, data: Hex) => {
      const hash = await wallet.sendTransaction({ to, data });
      const receipt = await pub.waitForTransactionReceipt({
        hash, timeout: 45_000, pollingInterval: 2_000,
      });
      if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
      return hash;
    };
    /**
     * Deploy a fresh UserRegistry proxy through the VerifiableFactory.
     *
     * The salt carries a per-request seed rather than being derived from the
     * label alone. A label-only salt looks tidier but is a trap: provisioning
     * ends with a userOp the client may never send, so the account can be left
     * with registries and no pointer at them. Retrying then hits CREATE2 at an
     * occupied address and reverts, which is exactly the dead end this replaces.
     * A retry now simply builds a new namespace; the earlier one is unreferenced
     * and harmless, and no guardian can exist under it yet.
     */
    const deployRegistry = async (tag: string): Promise<Address> => {
      const salt = BigInt(keccak256(toHex(`ensign:${tag}:${label}:${saltSeed}`)));
      const data = encodeFunctionData({
        abi: userRegistryAbi,
        functionName: "initialize",
        args: [bot.address, ALL_ROLES],
      });
      // deployProxy returns the address but a receipt won't carry it, so read
      // it off a simulation of the very call we are about to send.
      const { result } = await pub.simulateContract({
        account: bot, address: VERIFIABLE_FACTORY, abi: factoryAbi,
        functionName: "deployProxy", args: [USER_REGISTRY_IMPL, salt, data],
      });
      await send(
        VERIFIABLE_FACTORY,
        encodeFunctionData({
          abi: factoryAbi, functionName: "deployProxy",
          args: [USER_REGISTRY_IMPL, salt, data],
        }),
      );
      return result as Address;
    };

    /**
     * Deploy a resolver for one name and point it at `target`.
     *
     * Without this a name is registered but unresolvable, and the indexer skips
     * it — the reason guardian names never showed up on the explorer. The bot
     * is the resolver's admin so it can write the address record.
     */
    const deployResolver = async (name: string, target: Address): Promise<Address> => {
      const { result } = await pub.simulateContract({
        account: bot, address: VERIFIABLE_FACTORY, abi: factoryAbi,
        functionName: "deployProxy",
        args: [
          RESOLVER_IMPL,
          BigInt(keccak256(toHex(`ensign:res:${name}:${saltSeed}`))),
          encodeFunctionData({
            abi: resolverAbi, functionName: "initialize", args: [bot.address, ALL_ROLES],
          }),
        ],
      });
      const resolver = result as Address;
      await send(
        VERIFIABLE_FACTORY,
        encodeFunctionData({
          abi: factoryAbi, functionName: "deployProxy",
          args: [
            RESOLVER_IMPL,
            BigInt(keccak256(toHex(`ensign:res:${name}:${saltSeed}`))),
            encodeFunctionData({
              abi: resolverAbi, functionName: "initialize", args: [bot.address, ALL_ROLES],
            }),
          ],
        }),
      );
      // coinType 60 = SLIP-44 ETH, matching ENSignRegistry.
      await send(
        resolver,
        encodeFunctionData({
          abi: resolverAbi, functionName: "setAddr",
          args: [namehash(name), 60n, target],
        }),
      );
      return resolver;
    };

    // Already provisioned? The user's name points at its namespace registry,
    // and `recovery` inside that points at the one holding guardians. Reading
    // it back beats tracking state we'd only have to keep in sync.
    let namespaceRegistry = await read<Address>(STORAGE_REGISTRY, "getSubregistry", [label]);
    let methodsRegistry: Address;
    let needsSetSubregistry = false;

    if (namespaceRegistry === ZERO) {
      namespaceRegistry = await deployRegistry("rec-namespace");
      needsSetSubregistry = true; // only the account can re-point its own name
    }
    // Ask the namespace what `recovery` points at rather than assuming we are
    // the ones who put it there — a previous run may have got this far and
    // stopped before the client sent its userOp.
    methodsRegistry = await read<Address>(namespaceRegistry, "getSubregistry", ["recovery"]);
    if (methodsRegistry === ZERO) {
      methodsRegistry = await deployRegistry("rec-methods");
      const recoveryResolver = await deployResolver(recoveryName, account);
      await send(
        namespaceRegistry,
        encodeFunctionData({
          abi: registryAbi, functionName: "register",
          args: ["recovery", account, methodsRegistry, recoveryResolver, ALL_ROLES, expiry],
        }),
      );
    }

    // A namespace built before names carried resolvers is invisible to the
    // indexer. Retrofit rather than leaving those accounts stranded.
    if ((await read<Address>(namespaceRegistry, "getResolver", ["recovery"])) === ZERO) {
      const retrofit = await deployResolver(recoveryName, account);
      const recoveryTokenId = await read<bigint>(namespaceRegistry, "getTokenId", [
        labelId("recovery"),
      ]);
      await send(
        namespaceRegistry,
        encodeFunctionData({
          abi: registryAbi, functionName: "setResolver", args: [recoveryTokenId, retrofit],
        }),
      );
    }

    if (!withGuardian) {
      return NextResponse.json({
        namespaceRegistry,
        methodsRegistry,
        userTokenId: userTokenId.toString(),
        needsSetSubregistry,
        storageRegistry: STORAGE_REGISTRY,
        resource: null,
        guardianName: null,
        recoveryName,
      });
    }

    // The guardian itself: mom.recovery.<label>.ensign.eth, owned by the
    // guardian's wallet so the manager's live `ownerOf` resolves to them.
    const guardianTokenId = await read<bigint>(methodsRegistry, "getTokenId", [
      labelId(guardianLabel as string),
    ]);
    const existing = await read<Address>(methodsRegistry, "ownerOf", [guardianTokenId]);
    if (existing !== ZERO) {
      return NextResponse.json(
        { error: `guardian name "${guardianLabel}" is already taken for this account` },
        { status: 409 },
      );
    }
    const guardianName = `${guardianLabel}.${recoveryName}`;
    const guardianResolver = await deployResolver(guardianName, guardianAddress as Address);
    await send(
      methodsRegistry,
      encodeFunctionData({
        abi: registryAbi, functionName: "register",
        args: [guardianLabel as string, guardianAddress as Address,
               ZERO, guardianResolver, ALL_ROLES, expiry],
      }),
    );
    const mintedId = await read<bigint>(methodsRegistry, "getTokenId", [labelId(guardianLabel as string)]);
    const resource = await read<bigint>(methodsRegistry, "getResource", [mintedId]);

    return NextResponse.json({
      namespaceRegistry,
      methodsRegistry,
      resource: resource.toString(),
      userTokenId: userTokenId.toString(),
      needsSetSubregistry,
      storageRegistry: STORAGE_REGISTRY,
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
