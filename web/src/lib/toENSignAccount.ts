// ENSign smart-account adapter for viem.
//
// Wraps the JAW signing semantics (Solady ERC-7739 nested EIP-712, P-256 via WebAuthn,
// SignatureWrapper with owner index) into a viem `SmartAccount`. Once you have the
// account, viem's `bundlerClient.sendUserOperation` does correct gas estimation via the
// bundler's `eth_estimateUserOperationGas` — replacing all our hand-rolled gas math.
//
// Per-chain JAW address resolution:
//   - Sepolia (11155111): registry-derived (read from ENS `addr(node)`)
//   - All other chains:   factory-derived via canonical `JustanAccountFactory.getAddress`
//
// On non-Sepolia chains the JAW is lazy-deployed by EntryPoint via `factoryData`
// (createAccount call) on the first UserOp.

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  numberToHex,
  padHex,
  parseAbi,
  parseSignature,
  size,
  stringToHex,
} from "viem";

type ImplClient = SmartAccountImplementation<
  typeof entryPoint08Abi,
  "0.8"
>["client"];
import {
  type SmartAccount,
  type SmartAccountImplementation,
  toSmartAccount,
  toWebAuthnAccount,
  entryPoint08Abi,
  entryPoint08Address,
  getUserOperationTypedData,
  type WebAuthnAccount,
} from "viem/account-abstraction";
import {
  hashMessage as erc7739HashMessage,
  hashTypedData as erc7739HashTypedData,
  wrapTypedDataSignature,
} from "viem/experimental/erc7739";
import * as Signature from "ox/Signature";
import type * as WebAuthnP256 from "ox/WebAuthnP256";

import {
  JAW_FACTORY,
  SEPOLIA_CHAIN_ID,
  jawFactoryAbi,
  predictFactoryJaw,
  resolveLabel,
} from "./ensign";

const CONTRACT_NAME = "JustanAccount";
const CONTRACT_VERSION = "1";

const jawAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

const STUB_SIGNATURE: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000170000000000000000000000000000000000000000000000000000000000000001949fc7c88032b9fcb5f6efc7a7b8c63668eae9871b765e23123bb473ff57aa831a7c0d9276168ebcc29f2875a0239cffdf2a9cd1c2007c5c77c071db9264df1d000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008a7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a2273496a396e6164474850596759334b7156384f7a4a666c726275504b474f716d59576f4d57516869467773222c226f726967696e223a2268747470733a2f2f7369676e2e636f696e626173652e636f6d222c2263726f73734f726967696e223a66616c73657d00000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Signature wrapping (mirrors lib/toJustanAccount.ts)
// ---------------------------------------------------------------------------

function wrapSignature({
  ownerIndex = 0,
  signature,
}: {
  ownerIndex?: number;
  signature: Hex;
}): Hex {
  // ECDSA EOA path collapses 65-byte signatures into r||s||v packed.
  const signatureData =
    size(signature) === 65
      ? encodePacked(
          ["bytes32", "bytes32", "uint8"],
          (() => {
            const s = parseSignature(signature);
            return [s.r, s.s, s.yParity === 0 ? 27 : 28];
          })(),
        )
      : signature;
  return encodeAbiParameters(
    [
      {
        components: [
          { name: "ownerIndex", type: "uint8" },
          { name: "signatureData", type: "bytes" },
        ],
        type: "tuple",
      },
    ],
    [{ ownerIndex, signatureData }],
  );
}

function toWebAuthnSignature({
  webauthn,
  signature,
}: {
  webauthn: Partial<WebAuthnP256.SignMetadata> & {
    authenticatorData: Hex;
    clientDataJSON: string;
  };
  signature: Hex;
}): Hex {
  const { r, s } = Signature.fromHex(signature);
  return encodeAbiParameters(
    [
      {
        components: [
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "bytes" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
        type: "tuple",
      },
    ],
    [
      {
        authenticatorData: webauthn.authenticatorData,
        clientDataJSON: stringToHex(webauthn.clientDataJSON),
        challengeIndex: BigInt(
          webauthn.challengeIndex ?? webauthn.clientDataJSON.indexOf('"challenge"'),
        ),
        typeIndex: BigInt(webauthn.typeIndex ?? webauthn.clientDataJSON.indexOf('"type"')),
        r: padHex(numberToHex(r), { size: 32 }),
        s: padHex(numberToHex(s), { size: 32 }),
      },
    ],
  );
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type ToENSignAccountParams = {
  client: ImplClient;
  label: string;
  chainId: number;
};

export async function toENSignAccount(
  params: ToENSignAccountParams,
): Promise<SmartAccount> {
  const { client, label, chainId } = params;

  // 1) ENS is the source of truth for the passkey + per-chain JAW address.
  const ens = await resolveLabel(label);

  // 2) Build a viem WebAuthnAccount tied to the credentialId from ENS.
  // The browser uses the credentialId in `allowCredentials`, so the OS skips
  // the chooser and goes straight to Face ID for the right passkey.
  const ownerCredential = {
    id: ens.credentialId,
    publicKey: (("0x04" + ens.qx.slice(2) + ens.qy.slice(2)) as Hex),
  };
  const owner: WebAuthnAccount = toWebAuthnAccount({ credential: ownerCredential });

  // 3) Per-chain account address.
  const accountAddress: Address =
    chainId === SEPOLIA_CHAIN_ID
      ? ens.account
      : await predictFactoryJaw(ens.qx, ens.qy, 0n, chainId);

  // 4) Lazy factory args for non-Sepolia chains: EntryPoint will run
  // factory.createAccount(owners, 0) before validation if the JAW isn't
  // deployed yet at `accountAddress`.
  const ownersBytes: Hex[] = [
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [ens.qx, ens.qy],
    ) as Hex,
  ];
  const factoryData = encodeFunctionData({
    abi: jawFactoryAbi,
    functionName: "createAccount",
    args: [ownersBytes, 0n],
  });

  return toSmartAccount({
    client,
    entryPoint: {
      abi: entryPoint08Abi,
      address: entryPoint08Address,
      version: "0.8",
    },

    async getAddress() {
      return accountAddress;
    },

    async getFactoryArgs() {
      // Only Sepolia has the registry-deployed JAW; on other chains we lazy-deploy
      // via the canonical JAW factory.
      if (chainId === SEPOLIA_CHAIN_ID) {
        return { factory: undefined, factoryData: undefined };
      }
      // Skip factory once the JAW exists.
      const code = await client.request({
        method: "eth_getCode",
        params: [accountAddress, "latest"],
      } as never).catch(() => "0x");
      if (code && code !== "0x") {
        return { factory: undefined, factoryData: undefined };
      }
      return {
        factory: JAW_FACTORY,
        factoryData,
      };
    },

    async encodeCalls(calls) {
      if (calls.length === 1) {
        const c = calls[0]!;
        return encodeFunctionData({
          abi: jawAbi,
          functionName: "execute",
          args: [c.to as Address, c.value ?? 0n, (c.data ?? "0x") as Hex],
        });
      }
      return encodeFunctionData({
        abi: jawAbi,
        functionName: "executeBatch",
        args: [
          calls.map((c) => ({
            target: c.to as Address,
            value: c.value ?? 0n,
            data: (c.data ?? "0x") as Hex,
          })),
        ],
      });
    },

    async getStubSignature() {
      return STUB_SIGNATURE;
    },

    async signMessage({ message }) {
      const hash = erc7739HashMessage({
        message,
        verifierDomain: {
          name: CONTRACT_NAME,
          version: CONTRACT_VERSION,
          chainId,
          verifyingContract: accountAddress,
        },
      });
      const { signature, webauthn } = await owner.sign({ hash });
      return wrapSignature({
        ownerIndex: 0,
        signature: toWebAuthnSignature({ webauthn, signature }),
      });
    },

    async signTypedData(parameters) {
      const { domain = {}, types, primaryType, message } = parameters as {
        domain?: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const nestedHash = erc7739HashTypedData({
        domain,
        types,
        primaryType,
        message,
        verifierDomain: {
          chainId,
          name: CONTRACT_NAME,
          version: CONTRACT_VERSION,
          verifyingContract: accountAddress,
          salt:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        },
      } as never);
      const { signature, webauthn } = await owner.sign({ hash: nestedHash });
      const wrappedWithOwner = wrapSignature({
        ownerIndex: 0,
        signature: toWebAuthnSignature({ webauthn, signature }),
      });
      return wrapTypedDataSignature({
        domain,
        types,
        primaryType,
        message,
        signature: wrappedWithOwner,
      } as never);
    },

    async signUserOperation(parameters) {
      const { chainId: signChainId = chainId, ...userOperation } = parameters;
      const typedData = getUserOperationTypedData({
        chainId: signChainId,
        entryPointAddress: entryPoint08Address,
        userOperation: {
          ...userOperation,
          sender: accountAddress,
        },
      });
      const { signature, webauthn } = await owner.signTypedData(typedData);
      return wrapSignature({
        ownerIndex: 0,
        signature: toWebAuthnSignature({ webauthn, signature }),
      });
    },

    userOperation: {
      async estimateGas(userOperation) {
        // WebAuthn-owned JAWs need a generous verification gas floor — P-256
        // verification is the dominant cost at 800k–1M.
        return {
          verificationGasLimit: BigInt(
            Math.max(Number(userOperation.verificationGasLimit ?? 0n), 1_000_000),
          ),
        };
      },
    },
  });
}
