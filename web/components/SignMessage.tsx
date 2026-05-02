"use client";

import { useState } from 'react'
import {  type Hex } from 'viem'
import { getPublicClient } from '../lib/clients'
import type { SmartAccountState } from '../lib/types'

interface SignMessageProps {
  accountState: SmartAccountState
  onBack: () => void
}

export function SignMessage({ accountState, onBack }: SignMessageProps) {
  const [message, setMessage] = useState('')
  const [signature, setSignature] = useState<Hex | null>(null)
  const [verificationResult, setVerificationResult] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSign = async () => {
    if (!accountState.account || !message) return

    try {
      setIsLoading(true)
      setError(null)
      setVerificationResult(null)
      
      // Sign the message using the smart account
      const sig = await accountState.account.signMessage({ message })
      setSignature(sig)
      
      // Automatically verify after signing
      await handleVerify(sig)
    } catch (err) {
      console.error('Failed to sign message:', err)
      setError(err instanceof Error ? err.message : 'Failed to sign message')
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerify = async (sig?: Hex) => {
    const signatureToVerify = sig || signature
    if (!signatureToVerify || !message || !accountState.address) return

    try {
      setIsLoading(true)
      setError(null)
      
      const publicClient = getPublicClient()

      // Verify the signature using viem's verifyMessage
      const isValid = await publicClient.verifyMessage({
        address: accountState.address,
        message,
        signature: signatureToVerify
      })

      setVerificationResult(isValid)
    } catch (err) {
      console.error('Failed to verify signature:', err)
      setError(err instanceof Error ? err.message : 'Failed to verify signature')
      setVerificationResult(false)
    } finally {
      setIsLoading(false)
    }
  }

  const handleClear = () => {
    setMessage('')
    setSignature(null)
    setVerificationResult(null)
    setError(null)
  }

  return (
    <div className="sign-message">
      <h2>Sign & Verify Message</h2>

      <div className="form-section">
        <div className="form-group">
          <label htmlFor="message">Message to Sign:</label>
          <textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Enter your message here..."
            rows={4}
            disabled={isLoading}
          />
        </div>

        <div className="button-group">
          <button 
            onClick={handleSign} 
            disabled={!message || isLoading}
            className="primary-button"
          >
            {isLoading ? 'Signing...' : 'Sign Message'}
          </button>
          <button 
            onClick={handleClear}
            className="secondary-button"
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      )}

      {signature && (
        <div className="signature-section">
          <h3>Signature</h3>
          <div className="signature-display">
            <code>{signature}</code>
          </div>
          
          {verificationResult !== null && (
            <div className={`verification-result ${verificationResult ? 'valid' : 'invalid'}`}>
              <strong>Verification Result:</strong> {verificationResult ? '✓ Valid' : '✗ Invalid'}
            </div>
          )}
          
          {!verificationResult && signature && (
            <button 
              onClick={() => handleVerify()} 
              disabled={isLoading}
              className="secondary-button"
            >
              Verify Signature
            </button>
          )}
        </div>
      )}

      <div className="actions">
        <button onClick={onBack} className="secondary-button">
          Back to Dashboard
        </button>
      </div>
    </div>
  )
}