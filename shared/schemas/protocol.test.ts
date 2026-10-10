import { describe, expect, it } from 'vitest'
import { clientMessageSchema } from './protocol'

describe('strict client protocol', () => {
  it('accepts an explicit ready state', () => {
    expect(clientMessageSchema.parse({ type: 'PLAYER_READY', ready: false })).toEqual({
      type: 'PLAYER_READY',
      ready: false,
    })
  })
  it('accepts only the payload-free server-authorized start command shape', () => {
    expect(clientMessageSchema.parse({ type: 'START_GAME' })).toEqual({ type: 'START_GAME' })
    expect(
      clientMessageSchema.safeParse({ type: 'START_GAME', characterIds: ['attacker-choice'] })
        .success,
    ).toBe(false)
  })
  it.each([
    { type: 'PLAYER_READY', ready: 'true' },
    { type: 'PLAYER_READY', ready: true, playerId: 'another-player' },
    { type: 'PLAYER_READY', ready: true, hostId: 'attacker' },
    { type: 'ROOM_STATE', payload: { status: 'finished' } },
    { type: 'ASSIGN_CHARACTERS' },
    { type: 'LEAVE_ROOM', playerId: 'another-player' },
    null,
  ])('rejects unauthorized protocol shapes: %o', (message) => {
    expect(clientMessageSchema.safeParse(message).success).toBe(false)
  })
})
