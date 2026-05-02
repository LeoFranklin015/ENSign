export interface SavedPasskey {
  id: string
  name: string
  createdAt: number
  lastUsed?: number
}

const STORAGE_KEY = 'saved_passkeys'

export function getSavedPasskeys(): SavedPasskey[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    return JSON.parse(stored) as SavedPasskey[]
  } catch (error) {
    console.error('Failed to load saved passkeys:', error)
    return []
  }
}

export function savePasskey(passkey: Omit<SavedPasskey, 'createdAt'>): void {
  try {
    const passkeys = getSavedPasskeys()
    
    // Check if passkey already exists and update it
    const existingIndex = passkeys.findIndex(p => p.id === passkey.id)
    
    if (existingIndex >= 0) {
      // Update existing passkey
      passkeys[existingIndex] = {
        ...passkeys[existingIndex],
        ...passkey,
        lastUsed: Date.now()
      }
    } else {
      // Add new passkey
      passkeys.push({
        ...passkey,
        createdAt: Date.now(),
        lastUsed: Date.now()
      })
    }
    
    // Sort by last used (most recent first)
    passkeys.sort((a, b) => (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt))
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(passkeys))
  } catch (error) {
    console.error('Failed to save passkey:', error)
  }
}

export function updateLastUsed(passkeyId: string): void {
  try {
    const passkeys = getSavedPasskeys()
    const passkey = passkeys.find(p => p.id === passkeyId)
    
    if (passkey) {
      savePasskey({
        ...passkey,
        lastUsed: Date.now()
      })
    }
  } catch (error) {
    console.error('Failed to update passkey last used time:', error)
  }
}

export function removePasskey(passkeyId: string): void {
  try {
    const passkeys = getSavedPasskeys()
    const filtered = passkeys.filter(p => p.id !== passkeyId)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
  } catch (error) {
    console.error('Failed to remove passkey:', error)
  }
}

export function clearAllPasskeys(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.error('Failed to clear passkeys:', error)
  }
}