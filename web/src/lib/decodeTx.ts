// Best-effort calldata decoder for the tx-confirm screen.
//
// Strategy:
//   1. If `data` is empty / "0x", it's a plain ETH send. Done.
//   2. Otherwise, try whatsabi's autoload — Sourcify first, then 4byte signature
//      directory as a fallback. We only need a function fragment, not a full ABI.
//   3. Decode args with viem against whatever fragment we got.
//   4. Translate well-known ERC-20 / ERC-721 calls into a plain-English summary.
//
// Everything is best-effort: any failure returns `{ kind: "raw" }` so the UI
// can fall back to showing the selector + raw data.
import { decodeFunctionData, formatUnits, type AbiFunction, type Hex } from "viem";
import { autoload, loaders } from "@shazow/whatsabi";

// Minimal client shape we need. Avoids a viem dual-package-hazard with whatsabi's
// own viem dep, which surfaces "Two different types with this name exist" otherwise.
type Client = {
  chain?: { id: number };
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly AbiFunction[];
    functionName: string;
  }) => Promise<unknown>;
};

export type DecodedCall =
  | { kind: "transfer"; token: `0x${string}`; to: `0x${string}`; amountRaw: bigint; symbol?: string; decimals?: number; }
  | { kind: "approve"; token: `0x${string}`; spender: `0x${string}`; amountRaw: bigint; symbol?: string; decimals?: number; }
  | { kind: "function"; name: string; signature: string; args: { name: string; type: string; value: string }[] }
  | { kind: "unknown"; selector: string };

export type DecodeResult = {
  kind: "send-eth" | "decoded" | "raw";
  call?: DecodedCall;
  raw: Hex;
};

const ERC20_HUMAN: AbiFunction[] = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

const ERC20_METADATA: AbiFunction[] = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
];

function selectorFromData(data: Hex): string {
  return data.slice(0, 10).toLowerCase();
}

async function fetchTokenMeta(client: Client, token: `0x${string}`): Promise<{ symbol?: string; decimals?: number }> {
  try {
    const [sym, dec] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_METADATA, functionName: "symbol" }).catch(() => undefined),
      client.readContract({ address: token, abi: ERC20_METADATA, functionName: "decimals" }).catch(() => undefined),
    ]);
    return { symbol: sym as string | undefined, decimals: dec as number | undefined };
  } catch {
    return {};
  }
}

export async function decodeTx(opts: {
  client: Client;
  to: `0x${string}`;
  value: bigint;
  data: Hex;
}): Promise<DecodeResult> {
  const { client, to, value, data } = opts;

  if (!data || data === "0x" || data.length <= 2) {
    return { kind: "send-eth", raw: data };
  }

  const sel = selectorFromData(data);

  // Fast path: well-known ERC-20 selectors get human-friendly cards.
  // 0xa9059cbb = transfer(address,uint256)
  // 0x095ea7b3 = approve(address,uint256)
  if (sel === "0xa9059cbb" || sel === "0x095ea7b3") {
    try {
      const decoded = decodeFunctionData({ abi: ERC20_HUMAN, data });
      const meta = await fetchTokenMeta(client, to);
      const args = decoded.args as readonly [`0x${string}`, bigint];
      if (sel === "0xa9059cbb") {
        return {
          kind: "decoded",
          raw: data,
          call: {
            kind: "transfer",
            token: to,
            to: args[0],
            amountRaw: args[1],
            symbol: meta.symbol,
            decimals: meta.decimals,
          },
        };
      }
      return {
        kind: "decoded",
        raw: data,
        call: {
          kind: "approve",
          token: to,
          spender: args[0],
          amountRaw: args[1],
          symbol: meta.symbol,
          decimals: meta.decimals,
        },
      };
    } catch {
      // Fall through to whatsabi
    }
  }

  // Slow path: use whatsabi to fetch an ABI for the contract.
  try {
    const abiLoader = new loaders.MultiABILoader([
      new loaders.SourcifyABILoader({ chainId: client.chain?.id ?? 1 }),
    ]);
    const sigLookup = new loaders.MultiSignatureLookup([
      new loaders.OpenChainSignatureLookup(),
      new loaders.FourByteSignatureLookup(),
    ]);

    const result = await autoload(to, {
      // whatsabi's provider type is structurally compatible with viem clients
      // but the dependency-version shapes diverge — cast to silence TS.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: client as any,
      abiLoader,
      signatureLookup: sigLookup,
      followProxies: true,
    });

    const abi = result.abi as AbiFunction[];
    if (abi && abi.length > 0) {
      try {
        const decoded = decodeFunctionData({ abi, data });
        const fragment = abi.find(
          (f) => f.type === "function" && f.name === decoded.functionName,
        ) as AbiFunction | undefined;

        const argsList: { name: string; type: string; value: string }[] = [];
        const argValues = decoded.args ?? [];
        if (fragment) {
          fragment.inputs.forEach((input, i) => {
            const v = argValues[i];
            argsList.push({
              name: input.name || `arg${i}`,
              type: input.type,
              value: stringifyValue(v),
            });
          });
        }
        const sig = fragment
          ? `${fragment.name}(${fragment.inputs.map((i) => i.type).join(",")})`
          : decoded.functionName;
        return {
          kind: "decoded",
          raw: data,
          call: {
            kind: "function",
            name: decoded.functionName,
            signature: sig,
            args: argsList,
          },
        };
      } catch {
        // Couldn't decode against returned ABI — fall through.
      }
    }
  } catch {
    // autoload failed (network, no ABI on Sourcify, etc.)
  }

  // Last resort: just say which selector.
  return { kind: "decoded", raw: data, call: { kind: "unknown", selector: sel } };

  // (suppress unused warning for value — kept in signature for future)
  void value;
}

function stringifyValue(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return JSON.stringify(v.map(stringifyValue));
  return String(v);
}

/** Format a token amount with decimals fallback. */
export function formatTokenAmount(raw: bigint, decimals?: number, symbol?: string): string {
  if (decimals === undefined) {
    return symbol ? `${raw.toString()} ${symbol}` : raw.toString();
  }
  const formatted = formatUnits(raw, decimals);
  // Trim trailing zeros after decimal
  const tidy = formatted.includes(".")
    ? formatted.replace(/\.?0+$/, "")
    : formatted;
  return symbol ? `${tidy} ${symbol}` : tidy;
}
