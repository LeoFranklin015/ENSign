import type { Client, Hex } from "viem";
import { getGasPrice } from "viem/actions";
import type { PaymasterClient } from "viem/account-abstraction";
import { entryPoint08Address } from "viem/account-abstraction";

/// Some paymasters return `0x1` for paymasterVerificationGasLimit /
/// paymasterPostOpGasLimit on EP v0.8. Detect and re-estimate via the bundler.
const isBogus = (v: Hex | undefined): boolean => !v || BigInt(v) <= 1n;

async function estimateGas(
  paymasterClient: PaymasterClient,
  userOp: Record<string, unknown>,
  entryPoint: Hex,
) {
  const result = (await paymasterClient.request({
    method: "eth_estimateUserOperationGas" as never,
    params: [userOp as never, entryPoint as never] as never,
  })) as {
    preVerificationGas: Hex;
    verificationGasLimit: Hex;
    callGasLimit: Hex;
    paymasterVerificationGasLimit?: Hex;
    paymasterPostOpGasLimit?: Hex;
  };
  return result;
}

/// Wraps a viem `PaymasterClient` so it always supplies the gas prices and
/// gas limits Pimlico's verifying paymaster expects on EP v0.8. Without this,
/// `pm_getPaymasterStubData` rejects the request (no fees) and the response's
/// paymaster gas limits come back as `0x1`.
///
/// Plug the return value into `createBundlerClient({ paymaster: ... })`.
export function createPaymasterFunctions(
  client: Client,
  paymasterClient: PaymasterClient,
  chainId: number,
  context?: Record<string, unknown>,
) {
  return {
    async getPaymasterStubData(
      userOp: Parameters<PaymasterClient["getPaymasterStubData"]>[0],
    ) {
      let { maxFeePerGas, maxPriorityFeePerGas } = userOp;
      if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
        const gp = await getGasPrice(client);
        maxFeePerGas ??= gp;
        maxPriorityFeePerGas ??= gp;
      }

      const stub = await paymasterClient.getPaymasterStubData({
        ...userOp,
        maxFeePerGas,
        maxPriorityFeePerGas,
        chainId,
        entryPointAddress: userOp.entryPointAddress,
        ...(context && { context }),
      });

      const ep = userOp.entryPointAddress ?? entryPoint08Address;
      const needEstimate =
        isBogus(stub.paymasterVerificationGasLimit as Hex | undefined) ||
        isBogus(stub.paymasterPostOpGasLimit as Hex | undefined);

      if (!needEstimate) return stub;

      // Use the stub signature already on the userOp — viem populates it from
      // `account.getStubSignature()`, which for our WebAuthn account is a
      // properly ABI-encoded dummy. A hardcoded ECDSA dummy would revert in
      // validateUserOp's `abi.decode` and surface as AA23.
      const stubSig = (userOp as { signature?: Hex }).signature;
      if (!stubSig || stubSig === "0x") {
        throw new Error("paymasterFns: userOp missing stub signature");
      }

      try {
        const est = await estimateGas(
          paymasterClient,
          {
            sender: userOp.sender,
            nonce: `0x${(userOp.nonce ?? 0n).toString(16)}`,
            callData: userOp.callData,
            callGasLimit: "0x0",
            verificationGasLimit: "0x0",
            preVerificationGas: "0x0",
            maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
            maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
            signature: stubSig,
            paymaster: stub.paymaster,
            paymasterData: stub.paymasterData,
            ...(userOp.factory && { factory: userOp.factory }),
            ...(userOp.factoryData && { factoryData: userOp.factoryData }),
          },
          ep,
        );
        return {
          ...stub,
          paymasterVerificationGasLimit: isBogus(stub.paymasterVerificationGasLimit as Hex | undefined)
            ? est.paymasterVerificationGasLimit
            : stub.paymasterVerificationGasLimit,
          paymasterPostOpGasLimit: isBogus(stub.paymasterPostOpGasLimit as Hex | undefined)
            ? est.paymasterPostOpGasLimit
            : stub.paymasterPostOpGasLimit,
        } as typeof stub;
      } catch (e) {
        console.warn("[paymasterFns] gas estimation failed:", e);
        return stub;
      }
    },

    async getPaymasterData(
      userOp: Parameters<PaymasterClient["getPaymasterData"]>[0],
    ) {
      let { maxFeePerGas, maxPriorityFeePerGas } = userOp;
      if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
        const gp = await getGasPrice(client);
        maxFeePerGas ??= gp;
        maxPriorityFeePerGas ??= gp;
      }

      const data = await paymasterClient.getPaymasterData({
        ...userOp,
        maxFeePerGas,
        maxPriorityFeePerGas,
        chainId,
        entryPointAddress: userOp.entryPointAddress,
        ...(context && { context }),
      });

      // If gas limits weren't echoed back, carry them from the userOp
      // (which already has the values returned by getPaymasterStubData).
      const verBogus = isBogus(data.paymasterVerificationGasLimit as Hex | undefined);
      const postBogus = isBogus(data.paymasterPostOpGasLimit as Hex | undefined);
      if (!verBogus && !postBogus) return data;

      return {
        ...data,
        paymasterVerificationGasLimit: verBogus
          ? userOp.paymasterVerificationGasLimit
          : data.paymasterVerificationGasLimit,
        paymasterPostOpGasLimit: postBogus
          ? userOp.paymasterPostOpGasLimit
          : data.paymasterPostOpGasLimit,
      } as typeof data;
    },
  };
}
