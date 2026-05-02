import { NextResponse } from "next/server";
import { parseEther, type Hex } from "viem";
import {
  ENTRYPOINT,
  USER_OP_EVENT_TOPIC,
  account,
  clientsForChain,
  epAbi,
} from "@/lib/clients";

type PackedUserOp = {
  sender: `0x${string}`;
  nonce: string | bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: string | bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

type RelayBody = {
  userOp?: PackedUserOp;
  chainId?: number | string;
};

export async function POST(req: Request) {
  try {
    const { userOp, chainId } = (await req.json()) as RelayBody;
    if (!userOp) return NextResponse.json({ error: "userOp required" }, { status: 400 });

    const { pub: chainPub, wallet: chainWallet, chain } = clientsForChain(chainId ?? 11_155_111);
    console.log(`relay → ${chain} (chainId=${chainId})`);

    // Auto-deposit a small amount to EntryPoint on the user's behalf if balance is low,
    // so first UserOp on a new chain succeeds without manual setup.
    const epBal = (await chainPub.readContract({
      address: ENTRYPOINT,
      abi: epAbi,
      functionName: "balanceOf",
      args: [userOp.sender],
    })) as bigint;

    if (epBal < parseEther("0.001")) {
      try {
        const depositTx = await chainWallet.writeContract({
          address: ENTRYPOINT,
          abi: epAbi,
          functionName: "depositTo",
          args: [userOp.sender],
          value: parseEther("0.005"),
        });
        await chainPub.waitForTransactionReceipt({ hash: depositTx });
        console.log(`  pre-deposited 0.005 ETH for ${userOp.sender} on ${chain} (tx ${depositTx})`);
      } catch (e) {
        const err = e as { shortMessage?: string; message?: string };
        console.warn(`  pre-deposit failed (continuing): ${err?.shortMessage ?? err?.message ?? err}`);
      }
    }

    const op = [
      userOp.sender,
      BigInt(userOp.nonce),
      userOp.initCode,
      userOp.callData,
      userOp.accountGasLimits,
      BigInt(userOp.preVerificationGas),
      userOp.gasFees,
      userOp.paymasterAndData,
      userOp.signature,
    ] as const;

    const tx = await chainWallet.writeContract({
      address: ENTRYPOINT,
      abi: epAbi,
      functionName: "handleOps",
      args: [[op], account.address],
      gas: 2_500_000n,
    });
    const receipt = await chainPub.waitForTransactionReceipt({ hash: tx });

    let success = false;
    let gasUsed = "0";
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === ENTRYPOINT.toLowerCase() &&
        log.topics[0] === USER_OP_EVENT_TOPIC
      ) {
        const data = log.data.slice(2);
        success = parseInt(data.slice(64, 128), 16) === 1;
        gasUsed = BigInt("0x" + data.slice(192, 256)).toString();
      }
    }

    return NextResponse.json({
      tx,
      chain,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      success,
      gasUsed,
    });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    console.error("relay failed", e);
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 500 },
    );
  }
}
