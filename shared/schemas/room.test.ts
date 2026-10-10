import { describe, expect, it } from 'vitest'
import { joinRoomRequestSchema, nicknameSchema, roomCodeSchema, roomSchema } from './room'

describe('room input foundation contracts', () => {
  it('keeps a 6-digit code as a string, including leading zeroes', () => {
    expect(roomCodeSchema.parse('012345')).toBe('012345')
  })
  it.each(['12345', '1234567', 'abcdef', ' 123456', '１２３４５６', '', 123456])(
    'rejects invalid code %s',
    (code) => {
      expect(roomCodeSchema.safeParse(code).success).toBe(false)
    },
  )
  it('trims nicknames and supports international letters', () => {
    expect(nicknameSchema.parse('  Ada Yılmaz  ')).toBe('Ada Yılmaz')
    expect(nicknameSchema.parse('Zoë_2')).toBe('Zoë_2')
  })
  it.each([' ', 'a', 'a'.repeat(21), '<script>', 'name\nname', '🎤🎤'])(
    'rejects invalid nickname %s',
    (nickname) => {
      expect(nicknameSchema.safeParse(nickname).success).toBe(false)
    },
  )
  it('requires opaque idempotency credentials for join requests', () => {
    const valid = {
      nickname: 'Deniz',
      requestId: crypto.randomUUID(),
      requestToken: 'a'.repeat(64),
    }
    expect(joinRoomRequestSchema.parse(valid)).toEqual(valid)
    expect(joinRoomRequestSchema.safeParse({ nickname: 'Deniz' }).success).toBe(false)
    expect(joinRoomRequestSchema.safeParse({ ...valid, requestToken: 'short' }).success).toBe(false)
  })
  it('keeps lobby and started-state metadata consistent', () => {
    const base = {
      id: 'room-id',
      code: '012345',
      sceneId: 'future-scene',
      hostId: 'host',
      players: [
        {
          id: 'host',
          nickname: 'Host',
          connected: true,
          ready: true,
          characterIds: [],
        },
      ],
      expiresAt: 10_000,
      revision: 1,
    }
    expect(roomSchema.safeParse({ ...base, status: 'lobby', startedAt: null }).success).toBe(true)
    expect(roomSchema.safeParse({ ...base, status: 'lobby', startedAt: 1234 }).success).toBe(false)
    expect(roomSchema.safeParse({ ...base, status: 'playing', startedAt: null }).success).toBe(
      false,
    )
    expect(roomSchema.safeParse({ ...base, status: 'playing', startedAt: 1234 }).success).toBe(true)
  })
})
