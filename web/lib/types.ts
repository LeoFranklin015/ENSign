import type { SmartAccount } from 'viem/account-abstraction'
import type { Address } from 'viem'

export interface PasskeyCredential {
  id: string
  name: string
  credential: {
    id: string
    publicKey: `0x${string}`
    raw?: unknown // Include the actual WebAuthn credential for authentication
    [key: string]: unknown
  }
}

export interface SmartAccountState {
  account: SmartAccount | null
  address: Address | null
  isLoggedIn: boolean
}