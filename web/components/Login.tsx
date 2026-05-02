"use client";

import { useState, useEffect } from 'react'
import { loginWithPasskey, loginWithSpecificPasskey, fetchPasskeysByCredIds } from '../lib/webauthn'
import type { SmartAccountState } from '../lib/types'
import {createSmartAccount} from "@/lib/justanaccount";
import { getSavedPasskeys, updateLastUsed, removePasskey, savePasskey, type SavedPasskey } from '../lib/passkeyStorage'

interface LoginProps {
  onLoginSuccess: (state: SmartAccountState) => void
  onCreateNew: () => void
}

export function Login({ onLoginSuccess, onCreateNew }: LoginProps) {
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedPasskeys, setSavedPasskeys] = useState<SavedPasskey[]>([])
  const [quickSignInLoading, setQuickSignInLoading] = useState<string | null>(null)

  useEffect(() => {
    // Load saved passkeys on mount and sync with backend
    const loadAndSyncPasskeys = async () => {
      const savedKeys = getSavedPasskeys()
      setSavedPasskeys(savedKeys)
      
      // Sync display names from backend if we have saved passkeys
      if (savedKeys.length > 0) {
        const credIds = savedKeys.map(pk => pk.id)
        const backendPasskeys = await fetchPasskeysByCredIds(credIds)
        
        // Update local storage with backend display names
        backendPasskeys.forEach(backendPk => {
          const localPk = savedKeys.find(pk => pk.id === backendPk.credentialId)
          if (localPk && backendPk.displayName) {
            savePasskey({
              id: localPk.id,
              name: backendPk.displayName
            })
          }
        })
        
        // Refresh the list with updated names
        setSavedPasskeys(getSavedPasskeys())
      }
    }
    
    loadAndSyncPasskeys()
  }, [])

  const handleQuickSignIn = async (passkey: SavedPasskey) => {
    setQuickSignInLoading(passkey.id)
    setError(null)

    try {
      const passkeyCredential = await loginWithSpecificPasskey(passkey.id)
      
      if (!passkeyCredential) {
        setError('Authentication cancelled or passkey not available')
        // Remove passkey if it's no longer available
        removePasskey(passkey.id)
        setSavedPasskeys(getSavedPasskeys())
        return
      }

      // Update last used time
      updateLastUsed(passkey.id)

      // Recreate smart account from stored credential
      const smartAccount = await createSmartAccount(passkeyCredential)
      const address = await smartAccount.getAddress()

      onLoginSuccess({
        account: smartAccount,
        address,
        isLoggedIn: true
      })
    } catch (err) {
      console.error('Failed to quick sign in:', err)
      setError('Failed to authenticate with saved passkey. Please try again.')
    } finally {
      setQuickSignInLoading(null)
    }
  }

  const handleRemovePasskey = (passkeyId: string) => {
    removePasskey(passkeyId)
    setSavedPasskeys(getSavedPasskeys())
  }

  const handleLogin = async () => {
    setIsLoggingIn(true)
    setError(null)

    try {
      const passkeyCredential = await loginWithPasskey()
      
      if (!passkeyCredential) {
        setError('No passkey selected or authentication cancelled')
        return
      }

      // Save or update the passkey info in localStorage
      savePasskey({
        id: passkeyCredential.id,
        name: passkeyCredential.name || 'Passkey'
      })

      // Recreate smart account from stored credential
      const smartAccount = await createSmartAccount(passkeyCredential)
      const address = await smartAccount.getAddress()

      onLoginSuccess({
        account: smartAccount,
        address,
        isLoggedIn: true
      })
    } catch (err) {
      console.error('Failed to login:', err)
      setError('Failed to login with passkey. Please try again.')
    } finally {
      setIsLoggingIn(false)
    }
  }

  return (
    <div className="login">
      <h2>Welcome Back</h2>
      <p>Login with your existing passkey to access your smart account wallet.</p>

      {error && <div className="error">{error}</div>}

      {/* Quick Sign-In Section */}
      {savedPasskeys.length > 0 && (
        <div className="saved-passkeys">
          <h3>Quick Sign In</h3>
          <p className="subtitle">Select a saved passkey for faster access:</p>
          <div className="passkey-list">
            {savedPasskeys.map((passkey) => (
              <div key={passkey.id} className="passkey-item">
                <button
                  className="passkey-button"
                  onClick={() => handleQuickSignIn(passkey)}
                  disabled={quickSignInLoading === passkey.id || isLoggingIn}
                >
                  <span className="passkey-icon">🔑</span>
                  <div className="passkey-info">
                    <span className="passkey-name">{passkey.name}</span>
                    <span className="passkey-date">
                      Last used: {passkey.lastUsed 
                        ? new Date(passkey.lastUsed).toLocaleDateString()
                        : 'Never'}
                    </span>
                  </div>
                  {quickSignInLoading === passkey.id && (
                    <span className="loading-text">Authenticating...</span>
                  )}
                </button>
                <button
                  className="remove-button"
                  onClick={() => handleRemovePasskey(passkey.id)}
                  disabled={quickSignInLoading === passkey.id}
                  title="Remove saved passkey"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="divider">
            <span>or</span>
          </div>
        </div>
      )}

      <div className="button-group">
        <button 
          onClick={handleLogin} 
          disabled={isLoggingIn || quickSignInLoading !== null}
          className="primary-button"
        >
          {isLoggingIn ? 'Signing In...' : 'Browse All Passkeys'}
        </button>

        <button 
          onClick={onCreateNew}
          className="secondary-button"
          disabled={isLoggingIn || quickSignInLoading !== null}
        >
          Create New Passkey
        </button>
      </div>
    </div>
  )
}