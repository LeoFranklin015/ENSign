import { NextResponse } from "next/server";

import {
  createPublicClient,
  createWalletClient,
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

    const send = async (to: Address, data: Hex) => {
      const hash = await wallet.sendTransaction({ to, data });
      const receipt = await pub.waitForTransactionReceipt({
        hash, timeout: 45_000, pollingInterval: 2_000,
      });
      if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
      return hash;
    };
    const deployRegistry = async (tag: string): Promise<Address> => {
      const salt = BigInt(keccak256(toHex(`ensign:${tag}:${label}`)));
      const data = encodeFunctionData({
        abi: userRegistryAbi,
        functionName: "initialize",
        args: [bot.address, ALL_ROLES],
      });
      // Read the address back from a simulation: deployProxy returns it, but a
      // receipt won't, and CREATE2 prediction would mean reimplementing the
      // factory's salt derivation here.
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

    // Already provisioned? The user's name points at its namespace registry,
    // and `recovery` inside that points at the one holding guardians. Reading
    // it back beats tracking state we'd only have to keep in sync.
    let namespaceRegistry = await read<Address>(STORAGE_REGISTRY, "getSubregistry", [label]);
    let methodsRegistry: Address;
    let needsSetSubregistry = false;

    if (namespaceRegistry === "0x0000000000000000000000000000000000000000") {
      namespaceRegistry = await deployRegistry("rec-namespace");
      methodsRegistry = await deployRegistry("rec-methods");
      await send(
        namespaceRegistry,
        encodeFunctionData({
          abi: registryAbi, functionName: "register",
          args: ["recovery", account, methodsRegistry,
                 "0x0000000000000000000000000000000000000000", ALL_ROLES, expiry],
        }),
      );
      needsSetSubregistry = true; // only the account can re-point its own name
    } else {
      methodsRegistry = await read<Address>(namespaceRegistry, "getSubregistry", ["recovery"]);
      if (methodsRegistry === "0x0000000000000000000000000000000000000000") {
        return NextResponse.json(
          { error: "namespace exists but has no `recovery` subname; state is inconsistent" },
          { status: 409 },
        );
      }
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
        recoveryName: `recovery.${label}.${process.env.NEXT_PUBLIC_PARENT_NAME ?? "ensign.eth"}`,
      });
    }

    // The guardian itself: mom.recovery.<label>.ensign.eth, owned by the
    // guardian's wallet so the manager's live `ownerOf` resolves to them.
    const guardianTokenId = await read<bigint>(methodsRegistry, "getTokenId", [
      labelId(guardianLabel as string),
    ]);
    const existing = await read<Address>(methodsRegistry, "ownerOf", [guardianTokenId]);
    if (existing !== "0x0000000000000000000000000000000000000000") {
      return NextResponse.json(
        { error: `guardian name "${guardianLabel}" is already taken for this account` },
        { status: 409 },
      );
    }
    await send(
      methodsRegistry,
      encodeFunctionData({
        abi: registryAbi, functionName: "register",
        args: [guardianLabel as string, guardianAddress as Address,
               "0x0000000000000000000000000000000000000000",
               "0x0000000000000000000000000000000000000000", ALL_ROLES, expiry],
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
      guardianName: `${guardianLabel}.recovery.${label}.${process.env.NEXT_PUBLIC_PARENT_NAME ?? "ensign.eth"}`,
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 400 },
    );
  }
}
