import { useState, useEffect } from 'react'
import { formatEther } from 'viem'
import { getPublicClient } from '../lib/clients'
import type { SmartAccountState } from '../lib/types'

interface DashboardProps {
  accountState: SmartAccountState
  onSendETH: () => void
  onSendERC20?: () => void
  onSignMessage?: () => void
  onSignTypedData?: () => void
  onLogout: () => void
}

export function Dashboard({ accountState, onSendETH, onSendERC20, onSignMessage, onSignTypedData, onLogout }: DashboardProps) {
  const [balance, setBalance] = useState<string>('0')
  const [isLoadingBalance, setIsLoadingBalance] = useState(true)

  useEffect(() => {
    if (accountState.address) {
      loadBalance()
    }
  }, [accountState.address]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadBalance = async () => {
    if (!accountState.address) return

    try {
      setIsLoadingBalance(true)
      const publicClient = getPublicClient()
      const balanceWei = await publicClient.getBalance({
        address: accountState.address
      })
      setBalance(formatEther(balanceWei))
    } catch (error) {
      console.error('Failed to load balance:', error)
      setBalance('Error')
    } finally {
      setIsLoadingBalance(false)
    }
  }

  const copyAddress = async () => {
    if (accountState.address) {
      try {
        await navigator.clipboard.writeText(accountState.address)
        // Could add a toast notification here
      } catch (error) {
        console.error('Failed to copy address:', error)
      }
    }
  }

  return (
    <div className="dashboard">
      <div className="account-info">
        <h2>Smart Account Wallet</h2>
        
        <div className="address-section">
          <label>Account Address:</label>
          <div className="address-display">
            <span className="address">{accountState.address}</span>
            <button onClick={copyAddress} className="copy-button">
              Copy
            </button>
          </div>
        </div>

        <div className="balance-section">
          <label>Balance:</label>
          <div className="balance">
            {isLoadingBalance ? (
              'Loading...'
            ) : (
              `${balance} ETH`
            )}
            <button onClick={loadBalance} className="refresh-button">
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="actions">
        <button onClick={onSendETH} className="primary-button">
          Send ETH
        </button>
        {onSendERC20 && (
          <button onClick={onSendERC20} className="primary-button">
            Send ERC20
          </button>
        )}
        {onSignMessage && (
          <button onClick={onSignMessage} className="primary-button">
            Sign Message
          </button>
        )}
        {onSignTypedData && (
          <button onClick={onSignTypedData} className="primary-button">
            Sign Typed Data
          </button>
        )}
        <button onClick={onLogout} className="secondary-button">
          Logout
        </button>
      </div>
    </div>
  )
}