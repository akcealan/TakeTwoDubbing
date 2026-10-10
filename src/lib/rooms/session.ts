import { sessionSchema } from '../../../shared/schemas/room'
import type { RoomSession } from '../../../shared/schemas/protocol'

const memory = new Map<string, RoomSession>()
const key = (code: string) => `take-two:room:${code}`

export function saveSession(session: RoomSession): void {
  memory.set(session.code, session)
  try {
    sessionStorage.setItem(key(session.code), JSON.stringify(session))
  } catch {
    console.warn('Room session uses memory only; refresh recovery is unavailable.')
  }
}
export function loadSession(code: string): RoomSession | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(key(code))
  } catch {
    console.warn('Could not read saved room session; using in-memory recovery.')
    return memory.get(code) ?? null
  }
  if (raw) {
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(raw) as unknown)
      if (parsed.success && parsed.data.code === code) return parsed.data
    } catch {
      // Malformed browser data is stale, not a fatal recovery error.
    }
    try {
      sessionStorage.removeItem(key(code))
    } catch {
      console.warn('Could not remove an invalid saved room session.')
    }
  }
  return memory.get(code) ?? null
}
export function isSessionSaved(code: string): boolean {
  try {
    return sessionStorage.getItem(key(code)) !== null
  } catch {
    return false
  }
}
export function clearSession(code: string): void {
  memory.delete(code)
  try {
    sessionStorage.removeItem(key(code))
  } catch {
    console.warn('Could not remove the saved room session.')
  }
}
