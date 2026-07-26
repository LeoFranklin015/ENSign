import { NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

/**
 * Broadcast a recovery on the platform's behalf.
 *
 * Someone recovering has lost the device holding their passkey and very
 * likely has no ETH in the wallet they're standing at — and a guardian is
 * doing us a favour, not funding one. Making either of them pay gas is the
 * kind of friction that turns a recoverable account into a lost one.
 *
 * This is safe to expose because it grants nothing: the manager verifies the
 * proofs, the threshold, the nonce and the timelock on-chain. The worst a
 * caller can do is waste our gas on a transaction that reverts, so we simulate
 * first and refuse to broadcast anything that wouldn't succeed.
 */

const MANAGER = (process.env.NEXT_PUBLIC_RECOVERY_MANAGER ??
  "0xD952928319e72c3F96eBD3e6398a8421f0865846") as Address;

const managerAbi = parseAbi([
  "function requestRecovery(address account, bytes subject, (bytes32 recoveryId, bytes proof)[] approvals) returns (bytes32)",
  "function executeRecoveryRequest(bytes32 requestId)",
]);

export async function POST(req: Request) {
  try {
    const PK = process.env.BOT_PRIVATE_KEY as Hex | undefined;
    if (!PK) {
      return NextResponse.json({ error: "BOT_PRIVATE_KEY not set" }, { status: 500 });
    }

    const body = (await req.json()) as {
      action?: "request" | "execute";
      account?: Address;
      subject?: Hex;
      approvals?: { recoveryId: Hex; proof: Hex }[];
      requestId?: Hex;
    };

    const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
    const transport = http(rpc);
    const relayer = privateKeyToAccount(PK);
    const pub = createPublicClient({ chain: sepolia, transport });
    const wallet = createWalletClient({ account: relayer, chain: sepolia, transport });

    if (body.action === "request") {
      const { account, subject, approvals } = body;
      if (!account || !subject || !approvals?.length) {
        return NextResponse.json(
          { error: "account, subject and approvals are required" },
          { status: 400 },
        );
      }
      // Simulate first: a bad proof or short threshold should cost us nothing.
      const { request } = await pub.simulateContract({
        account: relayer,
        address: MANAGER,
        abi: managerAbi,
        functionName: "requestRecovery",
        args: [account, subject, approvals],
      });
      const tx = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash: tx });
      return NextResponse.json({ tx, status: receipt.status });
    }

    if (body.action === "execute") {
      if (!body.requestId) {
        return NextResponse.json({ error: "requestId is required" }, { status: 400 });
      }
      const { request } = await pub.simulateContract({
        account: relayer,
        address: MANAGER,
        abi: managerAbi,
        functionName: "executeRecoveryRequest",
        args: [body.requestId],
      });
      const tx = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash: tx });
      return NextResponse.json({ tx, status: receipt.status });
    }

    return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    return NextResponse.json(
      { error: String(err?.shortMessage ?? err?.message ?? err) },
      { status: 400 },
    );
  }
}
