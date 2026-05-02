import {type SmartAccount, toWebAuthnAccount} from "viem/account-abstraction";
import {type Address, encodeFunctionData, type Hash, parseEther} from "viem";
import type {PasskeyCredential} from "./types";
import {createERC20PaymasterBundlerClient, getBundlerClient, getPublicClient} from "./clients";
import {abi, toJustanAccount} from "./toJustanAccount";
import { erc20abi } from "@/abis/erc20abi";

async function findOwnerIndex(smartAccountAddress: Address, passkeyPublicKey: `0x${string}`): Promise<number> {
    const publicClient = getPublicClient();
    
    try {
        const code = await publicClient.getCode({
            address: smartAccountAddress,
        })
        const hasCode = code !== "0x" && code !== undefined;
        if(!hasCode) { return 0 }
        // Get the number of owners in the smart account
        const ownerCount = await publicClient.readContract({
            address: smartAccountAddress,
            abi: abi,
            functionName: 'ownerCount',
        }) as bigint;

        // Check each owner to find a match with our passkey public key
        for (let i = 0; i < Number(ownerCount); i++) {
            try {
                const ownerBytes = await publicClient.readContract({
                    address: smartAccountAddress,
                    abi: abi,
                    functionName: 'ownerAtIndex',
                    args: [BigInt(i)]
                }) as `0x${string}`;

                // Compare the owner bytes with our passkey public key
                if (ownerBytes.toLowerCase() === passkeyPublicKey.toLowerCase()) {
                    return i;
                }
            } catch (error) {
                // If ownerAtIndex reverts, continue to next index
                console.warn(`Failed to get owner at index ${i}:`, error);
            }
        }

        // If no match found, this means the passkey is not yet an owner
        // Return 0 as the default index for new accounts
        return 0;
    } catch (error) {
        // If ownerCount() reverts, it likely means the account hasn't been initialized yet
        // Return 0 as the default index for uninitialized accounts
        console.warn('Failed to get owner count, account may not be initialized:', error);
        return 0;
    }
}

export async function createSmartAccount(passkeyCredential: PasskeyCredential): Promise<SmartAccount> {
    const webauthnAccount = toWebAuthnAccount({
        credential: passkeyCredential.credential
    })

    const publicClient = getPublicClient()

    // First create a temporary smart account to get the predicted address
    const tempSmartAccount = await toJustanAccount({
        client: publicClient,
        owners: [webauthnAccount],
    })

    // Get the predicted smart account address
    const smartAccountAddress = await tempSmartAccount.getAddress()

    // Find the actual owner index for this passkey
    const ownerIndex = await findOwnerIndex(smartAccountAddress, webauthnAccount.publicKey)

    // Create the smart account with the correct owner index
    return await toJustanAccount({
        client: publicClient,
        owners: [webauthnAccount],
        ownerIndex,
    })
}

export async function sendTransaction(
    smartAccount: SmartAccount,
    to: Address,
    value?: bigint,
    data?: `0x${string}`
): Promise<Hash> {
    const bundlerClient = getBundlerClient(smartAccount)

    const userOpHash = await bundlerClient.sendUserOperation({
        account: smartAccount,
        calls: [{
            to,
            value: value ?? 0n,
            data: data ?? '0x'
        }],
    })

    console.log('UserOperation Hash:', userOpHash)

    // Wait for the transaction receipt and get the actual transaction hash
    const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash
    })

    console.log('Transaction Hash:', receipt.receipt.transactionHash)

    return receipt.receipt.transactionHash
}

export async function sendTransactionERC20Sponsored(
    smartAccount: SmartAccount,
    gasTokenAddress: Address,
    paymasterAddress: Address,
    to: Address,
    value?: bigint,
    data?: `0x${string}`
): Promise<Hash> {
    const bundlerClient = createERC20PaymasterBundlerClient(smartAccount)

    // Encode approval for the paymaster to spend gas tokens
    const approvalData = encodeFunctionData({
        abi: erc20abi,
        functionName: 'approve',
        args: [paymasterAddress, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')] // max uint256
    })

    const userOpHash = await bundlerClient.sendUserOperation({
        account: smartAccount,
        calls: [
            {
                to: gasTokenAddress,
                value: 0n,
                data: approvalData
            },
            {
                to,
                value: value ?? 0n,
                data: data ?? '0x'
            }
        ],
    })

    console.log('UserOperation Hash:', userOpHash)

    // Wait for the transaction receipt and get the actual transaction hash
    const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash
    })

    console.log('Transaction Hash:', receipt.receipt.transactionHash)

    return receipt.receipt.transactionHash
}

export async function sendETH(
    smartAccount: SmartAccount,
    to: Address,
    amount: string
): Promise<Hash> {
    return sendTransaction(smartAccount, to, parseEther(amount))
}

export async function sendERC20(
    smartAccount: SmartAccount,
    tokenAddress: Address,
    to: Address,
    amount: bigint,
    gasTokenAddress: Address,
    paymasterAddress: Address
): Promise<Hash> {
    const data = encodeFunctionData({
        abi: erc20abi,
        functionName: 'transfer',
        args: [to, amount]
    })
    return sendTransactionERC20Sponsored(
        smartAccount,
        gasTokenAddress,
        paymasterAddress,
        tokenAddress,
        0n,
        data
    )
}