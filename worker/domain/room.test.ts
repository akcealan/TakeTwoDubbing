import { describe, expect, it } from 'vitest'
import { addPlayer, chooseHost, newPlayer, removePlayer, setReady, updatePresence } from './room'
import type { Room } from '../../shared/types'
import { MAX_PLAYERS } from '../../shared/schemas/room'

function room(): Room {
  return {
    id: 'room-id',
    code: '012345',
    sceneId: 'a-small-step',
    hostId: 'host',
    status: 'lobby',
    startedAt: null,
    players: [newPlayer('host', 'Host')],
    expiresAt: 1000000,
    revision: 1,
  }
}

describe('authoritative lobby domain', () => {
  it('creates an unassigned, not-ready player with a trimmed nickname', () => {
    expect(newPlayer('p', '  Ada  ')).toEqual({
      id: 'p',
      nickname: 'Ada',
      connected: false,
      ready: false,
      characterIds: [],
    })
  })
  it('rejects conflicting nicknames including Unicode normalization', () => {
    const state = room()
    expect(() => addPlayer(state, newPlayer('p', 'HOST'))).toThrow('nickname')
    expect(() => addPlayer(state, newPlayer('p', 'Ｈｏｓｔ'))).toThrow('nickname')
  })
  it('enforces capacity, including disconnected reserved players', () => {
    const state = room()
    for (let i = 1; i < MAX_PLAYERS; i++) addPlayer(state, newPlayer(String(i), `Player ${i}`))
    expect(() => addPlayer(state, newPlayer('overflow', 'Extra'))).toThrow('limit')
    removePlayer(state, '1')
    expect(() => addPlayer(state, newPlayer('extra', 'Extra'))).not.toThrow()
  })
  it('changes readiness only for a connected member of a lobby', () => {
    const state = room()
    expect(() => setReady(state, 'outsider', true)).toThrow('session')
    expect(() => setReady(state, 'host', true)).toThrow('Reconnect')
    updatePresence(state, 'host', true)
    setReady(state, 'host', true)
    expect(state.players[0]?.ready).toBe(true)
    state.status = 'recording'
    expect(() => setReady(state, 'host', false)).toThrow('Reconnect')
  })
  it('hands hosting to a connected player on disconnect and resets readiness', () => {
    const state = room()
    addPlayer(state, newPlayer('guest', 'Guest'))
    updatePresence(state, 'host', true)
    updatePresence(state, 'guest', true)
    setReady(state, 'host', true)
    updatePresence(state, 'host', false)
    expect(state.hostId).toBe('guest')
    expect(state.players[0]?.ready).toBe(false)
    updatePresence(state, 'host', true)
    expect(state.hostId).toBe('guest')
    expect(state.status).toBe('lobby')
    expect(state.players.every((player) => player.characterIds.length === 0)).toBe(true)
  })
  it('retains a host when all are offline and assigns a returning player', () => {
    const state = room()
    addPlayer(state, newPlayer('guest', 'Guest'))
    chooseHost(state)
    expect(state.hostId).toBe('host')
    updatePresence(state, 'guest', true)
    expect(state.hostId).toBe('guest')
    removePlayer(state, 'guest')
    expect(state.hostId).toBe('host')
    removePlayer(state, 'host')
    expect(state.players).toEqual([])
  })
})
