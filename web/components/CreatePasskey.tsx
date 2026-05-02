"use client";

import { useState } from 'react'
import { createPasskey } from '../lib/webauthn'
import type { SmartAccountState } from '../lib/types'
import {createSmartAccount} from "@/lib/justanaccount";
import { savePasskey } from '../lib/passkeyStorage'

interface CreatePasskeyProps {
  onAccountCreated: (state: SmartAccountState) => void
}

export function CreatePasskey({ onAccountCreated }: CreatePasskeyProps) {
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Please enter a name for your passkey')
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      // Create WebAuthn credential
      const passkeyCredential = await createPasskey(name.trim())
      
      // Save passkey to localStorage for quick sign-in
      savePasskey({
        id: passkeyCredential.id,
        name: name.trim()
      })
      
      // Create smart account
      const smartAccount = await createSmartAccount(passkeyCredential)
      const address = await smartAccount.getAddress()

      onAccountCreated({
        account: smartAccount,
        address,
        isLoggedIn: true
      })
    } catch (err) {
      console.error('Failed to create passkey:', err)
      setError('Failed to create passkey. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="create-passkey">
      <h2>Create Your Passkey</h2>
      <p>Enter a name for your passkey to create your smart account wallet.</p>
      
      <div className="input-group">
        <label htmlFor="passkey-name">Passkey Name:</label>
        <input
          id="passkey-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., My Wallet Key"
          disabled={isCreating}
        />
      </div>

      {error && <div className="error">{error}</div>}

      <button 
        onClick={handleCreate} 
        disabled={isCreating || !name.trim()}
        className="primary-button"
      >
        {isCreating ? 'Creating...' : 'Create Passkey'}
      </button>
    </div>
  )
}