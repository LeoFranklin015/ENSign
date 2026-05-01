import { useState } from 'react'
import { isAddress, parseEther } from 'viem'
import type { SmartAccountState } from '../lib/types'
import {sendETH} from "../lib/justanaccount.ts";

interface SendTransactionProps {
  accountState: SmartAccountState
  onBack: () => void
  onSuccess: () => void
}

export function SendTransaction({ accountState, onBack, onSuccess }: SendTransactionProps) {
  const [toAddress, setToAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const validateInputs = (): string | null => {
    if (!toAddress.trim()) {
      return 'Please enter a recipient address'
    }

    if (!isAddress(toAddress)) {
      return 'Please enter a valid Ethereum address'
    }

    if (!amount.trim()) {
      return 'Please enter an amount'
    }

    try {
      const amountBigInt = parseEther(amount)
      if (amountBigInt <= 0n) {
        return 'Amount must be greater than 0'
      }
    } catch {
      return 'Please enter a valid amount'
    }

    return null
  }

  const handleSend = async () => {
    const validationError = validateInputs()
    if (validationError) {
      setError(validationError)
      return
    }

    if (!accountState.account) {
      setError('No smart account available')
      return
    }

    setIsSending(true)
    setError(null)
    setTxHash(null)

    try {
      const txHash = await sendETH(
        accountState.account,
        toAddress as `0x${string}`,
        amount,
      )

      setTxHash(txHash)
      console.log('Transaction confirmed with hash:', txHash)

      onSuccess()
    } catch (err) {
      console.error('Failed to send transaction:', err)
      setError('Failed to send transaction. Please try again.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="send-transaction">
      <h2>Send ETH</h2>

      <div className="form">
        <div className="input-group">
          <label htmlFor="to-address">Recipient Address:</label>
          <input
            id="to-address"
            type="text"
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
            placeholder="0x..."
            disabled={isSending}
          />
        </div>

        <div className="input-group">
          <label htmlFor="amount">Amount (ETH):</label>
          <input
            id="amount"
            type="number"
            step="0.0001"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.001"
            disabled={isSending}
          />
        </div>
        {error && <div className="error">{error}</div>}

        {txHash && (
          <div className="success">
            <p>Transaction confirmed!</p>
            <p className="tx-hash">
              Hash: {txHash.slice(0, 10)}...{txHash.slice(-8)}
            </p>
          </div>
        )}

        <div className="button-group">
          <button
            onClick={handleSend}
            disabled={isSending}
            className="primary-button"
          >
            {isSending ? 'Sending...' : 'Send ETH'}
          </button>
          
          <button
            onClick={onBack}
            disabled={isSending}
            className="secondary-button"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  )
}