import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomSession } from '../../../shared/schemas/protocol'
import { clearSession, isSessionSaved, loadSession, saveSession } from './session'

const session: RoomSession = {
  code: '012345',
  roomId: crypto.randomUUID(),
  playerId: crypto.randomUUID(),
  token: 'a'.repeat(64),
}

describe('room session recovery', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => {
    clearSession(session.code)
    vi.restoreAllMocks()
  })

  it('continues in memory when browser storage rejects writes and reads', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    saveSession(session)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(loadSession(session.code)).toEqual(session)
    expect(isSessionSaved(session.code)).toBe(false)
    expect(warning).toHaveBeenCalled()
  })

  it('ignores malformed saved data and still permits safe cleanup', () => {
    sessionStorage.setItem(`take-two:room:${session.code}`, '{broken')
    expect(loadSession(session.code)).toBeNull()
    expect(sessionStorage.getItem(`take-two:room:${session.code}`)).toBeNull()
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => clearSession(session.code)).not.toThrow()
  })
})
