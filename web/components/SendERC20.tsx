"use client";

import { useState } from 'react'
import { type Address, isAddress, parseUnits } from 'viem'
import type { SmartAccount } from 'viem/account-abstraction'
import { sendERC20 } from '../lib/justanaccount'

interface SendERC20Props {
  smartAccount: SmartAccount | null
}

export function SendERC20({ smartAccount }: SendERC20Props) {
  const [tokenAddress, setTokenAddress] = useState('')
  const [gasTokenAddress, setGasTokenAddress] = useState('')
  const [paymasterAddress, setPaymasterAddress] = useState('')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [decimals, setDecimals] = useState('18')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const handleSend = async () => {
    if (!smartAccount) {
      setError('No smart account connected')
      return
    }

    if (!isAddress(tokenAddress)) {
      setError('Invalid token address')
      return
    }

    if (!isAddress(gasTokenAddress)) {
      setError('Invalid gas token address')
      return
    }

    if (!isAddress(paymasterAddress)) {
      setError('Invalid paymaster address')
      return
    }

    if (!isAddress(recipient)) {
      setError('Invalid recipient address')
      return
    }

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      setError('Invalid amount')
      return
    }

    setLoading(true)
    setError(null)
    setTxHash(null)

    try {
      const parsedAmount = parseUnits(amount, Number(decimals))
      const hash = await sendERC20(
        smartAccount,
        tokenAddress as Address,
        recipient as Address,
        parsedAmount,
        gasTokenAddress as Address,
        paymasterAddress as Address
      )
      setTxHash(hash)
      setTokenAddress('')
      setGasTokenAddress('')
      setPaymasterAddress('')
      setRecipient('')
      setAmount('')
    } catch (err) {
      console.error('Failed to send ERC20:', err)
      setError(err instanceof Error ? err.message : 'Failed to send ERC20')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
        Send ERC20 Token
      </h3>

      <div className="space-y-3">
        <div>
          <label htmlFor="token-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Token Address (to send)
          </label>
          <input
            id="token-address"
            type="text"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            placeholder="0x..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                     bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
        </div>

        <div>
          <label htmlFor="gas-token-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Gas Token Address (for gas payment)
          </label>
          <input
            id="gas-token-address"
            type="text"
            value={gasTokenAddress}
            onChange={(e) => setGasTokenAddress(e.target.value)}
            placeholder="0x... (e.g., USDC)"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                     bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
        </div>

        <div>
          <label htmlFor="paymaster-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Paymaster Address
          </label>
          <input
            id="paymaster-address"
            type="text"
            value={paymasterAddress}
            onChange={(e) => setPaymasterAddress(e.target.value)}
            placeholder="0x..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                     bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
        </div>

        <div>
          <label htmlFor="recipient" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Recipient Address
          </label>
          <input
            id="recipient"
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                     bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                     focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
        </div>

        <div className="flex space-x-2">
          <div className="flex-1">
            <label htmlFor="amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Amount
            </label>
            <input
              id="amount"
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                       bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            />
          </div>

          <div className="w-24">
            <label htmlFor="decimals" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Decimals
            </label>
            <input
              id="decimals"
              type="number"
              value={decimals}
              onChange={(e) => setDecimals(e.target.value)}
              placeholder="18"
              min="0"
              max="18"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md
                       bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            />
          </div>
        </div>

        <button
          onClick={handleSend}
          disabled={loading || !smartAccount}
          className="w-full px-4 py-2 bg-blue-500 text-white rounded-md
                   hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500
                   disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Sending...' : 'Send ERC20'}
        </button>

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {txHash && (
          <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md">
            <p className="text-sm text-green-600 dark:text-green-400">
              Transaction sent successfully!
            </p>
            <a
              href={`https://sepolia.etherscan.io/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              View on Etherscan
            </a>
          </div>
        )}
      </div>
    </div>
  )
}