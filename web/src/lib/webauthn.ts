import { createWebAuthnCredential, toWebAuthnAccount } from 'viem/account-abstraction'
import type { WebAuthnAccount } from 'viem/account-abstraction'
import type { PasskeyCredential } from './types'

// Backend API configuration
const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://api.justaname.id'
const API_KEY = import.meta.env.VITE_API_KEY || 'VJZaS2Pq14R4r1kIdBPV3NprnMeJGJED'

// Backend API types
interface PasskeyRegistrationRequest {
  credentialId: string
  publicKey: string
  displayName: string
}

export interface PasskeyLookupResponse {
  credentialId: string
  publicKey: string
  displayName: string
}

interface BackendResponse<T> {
  statusCode: number
  result: {
    data: T
    error: null | string
  }
}

interface PasskeysByCredIdsResponse {
  passkeys: PasskeyLookupResponse[]
}

// API helper functions
async function registerPasskeyInBackend(request: PasskeyRegistrationRequest): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/wallet/v2/passkeys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Registration failed: ${response.status} - ${errorText || response.statusText}`)
  }
}

async function lookupPasskeysFromBackend(credentialIds: string[]): Promise<PasskeyLookupResponse[]> {
  const params = new URLSearchParams()
  credentialIds.forEach(id => params.append('credentialIds', id))

  const response = await fetch(`${API_BASE_URL}/wallet/v2/passkeys?${params}`, {
    headers: {
      'x-api-key': API_KEY
    }
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Passkeys not found')
    }
    const errorText = await response.text()
    throw new Error(`Failed to lookup passkeys: ${response.status} - ${errorText || response.statusText}`)
  }

  const backendResponse: BackendResponse<PasskeysByCredIdsResponse> = await response.json()

  if (backendResponse.result?.data?.passkeys) {
    return backendResponse.result.data.passkeys
  } else if (backendResponse.result?.error) {
    throw new Error(`Backend error: ${backendResponse.result.error}`)
  } else {
    throw new Error('Invalid response structure from backend')
  }
}

async function lookupPasskeyFromBackend(credentialId: string): Promise<PasskeyLookupResponse> {
  const passkeys = await lookupPasskeysFromBackend([credentialId])

  if (passkeys.length === 0) {
    throw new Error('Passkey not found')
  }

  const passkey = passkeys[0]
  if (!passkey) {
    throw new Error('Passkey not found')
  }

  return passkey
}

export async function createPasskey(name: string): Promise<PasskeyCredential> {
  try {
    const credential = await createWebAuthnCredential({ 
      name: name.trim() 
    })

    await registerPasskeyInBackend({
      credentialId: credential.id,
      publicKey: credential.publicKey,
      displayName: name.trim(),
    })

    return {
      id: credential.id,
      name: name.trim(),
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
      }
    }
  } catch {
    throw new Error('Failed to create passkey. Please try again.')
  }
}

export async function loginWithPasskey(): Promise<PasskeyCredential> {
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32))

    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        userVerification: 'preferred',
        timeout: 60000,
      },
    }) as PublicKeyCredential

    if (!credential) {
      throw new Error('No credential selected')
    }

    const credentialIdBase64 = btoa(
      String.fromCharCode(...new Uint8Array(credential.rawId))
    ).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

    const passkeyData = await lookupPasskeyFromBackend(credentialIdBase64)

    return {
      id: credentialIdBase64,
      name: passkeyData.displayName || 'Passkey',
      credential: {
        id: credentialIdBase64,
        publicKey: passkeyData.publicKey as `0x${string}`,
        raw: credential,
      }
    }
  } catch {
    throw new Error('Failed to authenticate with passkey. Please try again.')
  }
}

export async function loginWithSpecificPasskey(credentialId: string): Promise<PasskeyCredential> {
  try {
    const base64 = credentialId.replace(/-/g, '+').replace(/_/g, '/')
    const paddedBase64 = base64 + '=='.substring(0, (4 - (base64.length % 4)) % 4)
    const credentialIdArray = Uint8Array.from(atob(paddedBase64), (c) => c.charCodeAt(0))

    const challenge = crypto.getRandomValues(new Uint8Array(32))

    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: challenge,
        allowCredentials: [{
          id: credentialIdArray,
          type: 'public-key',
          transports: ['internal', 'hybrid'],
        }],
        userVerification: 'preferred',
        timeout: 60000,
      },
    }) as PublicKeyCredential

    if (!credential) {
      throw new Error('Failed to authenticate with specified passkey')
    }

    const passkeyData = await lookupPasskeyFromBackend(credentialId)

    return {
      id: credentialId,
      name: passkeyData.displayName || 'Passkey',
      credential: {
        id: credentialId,
        publicKey: passkeyData.publicKey as `0x${string}`,
        raw: credential,
      }
    }
  } catch {
    throw new Error('Failed to authenticate with the specified passkey. Please try again.')
  }
}

export async function fetchPasskeysByCredIds(credentialIds: string[]): Promise<PasskeyLookupResponse[]> {
  try {
    return await lookupPasskeysFromBackend(credentialIds)
  } catch (error) {
    console.error('Failed to fetch passkeys:', error)
    return []
  }
}

export function toJAWWebAuthnAccount(credential: PasskeyCredential): WebAuthnAccount {
  return toWebAuthnAccount({
    credential: credential.credential
  })
}