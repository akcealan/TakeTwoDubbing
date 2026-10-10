const STORAGE_KEY = 'take-two-scene-studio-key'
let memoryToken: string | null = null

export function getStudioToken(): string {
  if (memoryToken) return memoryToken
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && /^[a-f0-9]{64}$/.test(saved)) return (memoryToken = saved)
  } catch {
    // A memory-only key still keeps the current tab functional.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  memoryToken = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  try {
    localStorage.setItem(STORAGE_KEY, memoryToken)
  } catch {
    // Private scenes will not survive as discoverable data in this browser profile.
  }
  return memoryToken
}

export function studioAuthorization() {
  return `Bearer ${getStudioToken()}`
}
