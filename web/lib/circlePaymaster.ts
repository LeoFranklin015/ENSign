import { encodePacked, type Address } from "viem";
import { signPermit } from "./permit.js";

const paymasterAddress = process.env.NEXT_PUBLIC_PAYMASTER_V08_ADDRESS as Address;
const usdcAddress = process.env.NEXT_PUBLIC_USDC_ADDRESS as Address;

export function createCirclePaymaster(account: any, client: any) {
  return {
    async getPaymasterData() {
      const permitAmount = 10000000n;
      const permitSignature = await signPermit({
        tokenAddress: usdcAddress,
        account,
        client,
        spenderAddress: paymasterAddress,
        permitAmount: permitAmount,
      });

      const paymasterData = encodePacked(
        ["uint8", "address", "uint256", "bytes"],
        [0, usdcAddress, permitAmount, permitSignature],
      );

      return {
        paymaster: paymasterAddress,
        paymasterData,
        paymasterVerificationGasLimit: 200000n,
        paymasterPostOpGasLimit: 15000n,
        isFinal: true,
      };
    },
  };
}