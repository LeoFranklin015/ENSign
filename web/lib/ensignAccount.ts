import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  stringToHex,
  numberToHex,
  padHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  entryPoint08Abi,
  entryPoint08Address,
  toSmartAccount,
  type SmartAccount,
  type UserOperation,
} from "viem/account-abstraction";
import { getUserOperationHash } from "viem/account-abstraction";

const accountAbi = parseAbi([
  "function execute(address,uint256,bytes)",
]);

const factoryAbi = parseAbi([
  "function getAddress(bytes[] owners, uint256 nonce) view returns (address)",
  "function createAccount(bytes[] owners, uint256 nonce) payable returns (address)",
]);

/// A WebAuthn signature, properly ABI-encoded so the smart account's
/// `validateUserOp` can `abi.decode` without reverting during simulation.
/// Returned by `getStubSignature`.
function dummySig(): Hex {
  const cdj =
    '{"type":"webauthn.get","challenge":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","origin":"https://example.com","crossOrigin":false}';
  const auth = encodeAbiParameters(
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
        authenticatorData: ("0x" + "00".repeat(37)) as Hex,
        clientDataJSON: stringToHex(cdj),
        challengeIndex: BigInt(cdj.indexOf('"challenge"')),
        typeIndex: BigInt(cdj.indexOf('"type"')),
        r: ("0x" + "00".repeat(32)) as Hex,
        s: ("0x" + "00".repeat(32)) as Hex,
      },
    ],
  );
  return encodeAbiParameters(
    [
      {
        components: [
          { name: "ownerIndex", type: "uint256" },
          { name: "signatureData", type: "bytes" },
        ],
        type: "tuple",
      },
    ],
    [{ ownerIndex: 0n, signatureData: auth }],
  );
}

const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const lowS = (s: bigint): bigint => (s > N / 2n ? N - s : s);

function base64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function parseDerEcdsa(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("invalid DER");
  if (der[offset] & 0x80) offset += 1 + (der[offset] & 0x7f);
  else offset += 1;
  const readInt = (): bigint => {
    if (der[offset++] !== 0x02) throw new Error("invalid DER int");
    const len = der[offset++];
    let bytes = der.subarray(offset, offset + len);
    offset += len;
    if (bytes[0] === 0) bytes = bytes.subarray(1);
    return BigInt("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""));
  };
  return { r: readInt(), s: readInt() };
}

/// Run a WebAuthn ceremony to sign a 32-byte challenge with the user's
/// passkey, then ABI-encode the result in the format JustanAccount /
/// Solady's WebAuthn lib expects.
async function signWithPasskey(challenge: Hex, credentialId: string): Promise<Hex> {
  const challengeBytes = new Uint8Array(
    challenge
      .slice(2)
      .match(/.{2}/g)!
      .map((h) => parseInt(h, 16)),
  );

  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: challengeBytes,
      rpId: window.location.hostname,
      userVerification: "required",
      timeout: 60_000,
      allowCredentials: [
        {
          id: base64UrlToBytes(credentialId),
          type: "public-key",
          transports: ["internal", "hybrid"],
        },
      ],
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey prompt cancelled");

  const r = cred.response as AuthenticatorAssertionResponse;
  const authenticatorData = bytesToHex(new Uint8Array(r.authenticatorData));
  const clientDataJSON = new TextDecoder().decode(r.clientDataJSON);
  const { r: rVal, s: sVal } = parseDerEcdsa(new Uint8Array(r.signature));

  const webAuthnAuth = encodeAbiParameters(
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
        authenticatorData,
        clientDataJSON: stringToHex(clientDataJSON),
        challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')),
        typeIndex: BigInt(clientDataJSON.indexOf('"type"')),
        r: padHex(numberToHex(rVal), { size: 32 }),
        s: padHex(numberToHex(lowS(sVal)), { size: 32 }),
      },
    ],
  );

  return encodeAbiParameters(
    [
      {
        components: [
          { name: "ownerIndex", type: "uint256" },
          { name: "signatureData", type: "bytes" },
        ],
        type: "tuple",
      },
    ],
    [{ ownerIndex: 0n, signatureData: webAuthnAuth }],
  );
}

export type EnsignAccountParams = {
  client: PublicClient;
  /// The deployed JAW address. We always pre-deploy at registration time.
  account: Address;
  /// Base64url credential id from the WebAuthn ceremony at signup.
  credentialId: string;
  /// Owner slot the credential lives in. Defaults to 0 (single-passkey accounts).
  ownerIndex?: number;
};

/// Build a viem `SmartAccount` for an already-deployed ENSign smart account.
/// All UserOps signed via this account use the user's passkey and target
/// EntryPoint v0.8.
export async function toEnsignAccount(
  params: EnsignAccountParams,
): Promise<SmartAccount> {
  const { client, account, credentialId, ownerIndex = 0 } = params;

  return toSmartAccount({
    client,
    entryPoint: {
      abi: entryPoint08Abi,
      address: entryPoint08Address,
      version: "0.8",
    },
    extend: { factoryAbi },

    async getAddress() {
      return account;
    },

    /// Always already-deployed in V1 — registration deploys the account
    /// atomically. Returning empty factory args tells the bundler not to
    /// include `factory` / `factoryData` in the UserOp.
    async getFactoryArgs() {
      return { factory: undefined, factoryData: undefined };
    },

    async encodeCalls(calls) {
      if (calls.length !== 1) {
        throw new Error("ENSign V1 only supports single-call UserOps");
      }
      const c = calls[0];
      return encodeFunctionData({
        abi: accountAbi,
        functionName: "execute",
        args: [c.to, c.value ?? 0n, c.data ?? "0x"],
      });
    },

    async getStubSignature() {
      return dummySig();
    },

    async signUserOperation(parameters) {
      const { chainId = client.chain?.id, ...userOp } = parameters;
      if (!chainId) throw new Error("signUserOperation: chainId required");

      const hash = getUserOperationHash({
        chainId,
        entryPointAddress: entryPoint08Address,
        entryPointVersion: "0.8",
        userOperation: { ...userOp, sender: account } as UserOperation<"0.8">,
      });
      return signWithPasskey(hash, credentialId);
    },

    async signMessage() {
      throw new Error("signMessage not supported on ENSign smart accounts");
    },

    async signTypedData() {
      throw new Error("signTypedData not supported on ENSign smart accounts");
    },

    // Tell viem we're using ownerIndex 0; not part of the SmartAccount
    // interface, but useful for callers that need to know.
    ...({ ownerIndex } as object),
  });
}
