import { encodePacked } from "viem";
import { signPermit } from "./permit.js";

const paymasterAddress = import.meta.env.VITE_PAYMASTER_V08_ADDRESS;

export function createCirclePaymaster(account: any, client: any) {
  return {
    async getPaymasterData() {
      const permitAmount = 10000000n;
      const permitSignature = await signPermit({
        tokenAddress: import.meta.env.VITE_USDC_ADDRESS,
        account,
        client,
        spenderAddress: paymasterAddress,
        permitAmount: permitAmount,
      });

      const paymasterData = encodePacked(
        ["uint8", "address", "uint256", "bytes"],
        [0, import.meta.env.VITE_USDC_ADDRESS, permitAmount, permitSignature],
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