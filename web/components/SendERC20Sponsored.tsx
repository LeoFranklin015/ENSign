"use client";

import { useState } from 'react'
import { isAddress, parseEther, type Address } from 'viem'
import { createERC20PaymasterBundlerClient } from '../lib/clients'
import type { SmartAccount } from 'viem/account-abstraction'

interface SendERC20SponsoredProps {
  account: SmartAccount | null
}

export function SendERC20Sponsored({ account }: SendERC20SponsoredProps) {
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [tokenAddress, setTokenAddress] = useState<Address>('0x' as Address)
  const [loading, setLoading] = useState(false)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sendTransaction = async () => {
    if (!account) {
      setError('No account connected')
      return
    }

    if (!isAddress(recipient)) {
      setError('Invalid recipient address')
      return
    }

    if (!isAddress(tokenAddress)) {
      setError('Invalid ERC20 token address')
      return
    }

    try {
      setLoading(true)
      setError(null)
      setTxHash(null)

      const bundlerClient = createERC20PaymasterBundlerClient(account)

      const userOpHash = await bundlerClient.sendUserOperation({
        account,
        calls: [{
          to: recipient as Address,
          value: parseEther(amount),
        }],
      })

      const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash,
      })

      setTxHash(receipt.receipt.transactionHash)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card">
      <h3>Send Transaction (ERC20 Sponsored)</h3>

      <div>
        <label>
          ERC20 Token Address (for gas payment):
          <input
            type="text"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value as Address)}
            placeholder="0x..."
            disabled={loading}
          />
        </label>
      </div>

      <div>
        <label>
          Recipient:
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x..."
            disabled={loading}
          />
        </label>
      </div>

      <div>
        <label>
          Amount (ETH):
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.001"
            disabled={loading}
          />
        </label>
      </div>

      <button
        onClick={sendTransaction}
        disabled={!account || loading || !recipient || !amount || !tokenAddress}
      >
        {loading ? 'Sending...' : 'Send ETH (Pay with ERC20)'}
      </button>

      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
      {txHash && (
        <p style={{ color: 'green' }}>
          Transaction sent! Hash: {txHash}
        </p>
      )}
    </div>
  )
}