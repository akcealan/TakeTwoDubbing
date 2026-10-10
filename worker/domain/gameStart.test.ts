import { describe, expect, it } from 'vitest'
import type { Room } from '../../shared/types'
import { distributeCharacters, newPlayer, startGame } from './room'

const characters = ['captain', 'sidekick', 'computer', 'villain', 'narrator']

function room(playerCount: number, disconnected: number[] = []): Room {
  const players = Array.from({ length: playerCount }, (_, index) => {
    const player = newPlayer(`player-${index + 1}`, `Player ${index + 1}`)
    player.connected = !disconnected.includes(index)
    player.ready = player.connected
    return player
  })
  return {
    id: 'room-id',
    code: '012345',
    sceneId: 'future-scene',
    hostId: players[0]?.id ?? 'player-1',
    status: 'lobby',
    startedAt: null,
    players,
    expiresAt: 1_000_000,
    revision: 1,
  }
}

function assigned(room: Room) {
  return room.players.flatMap((player) => player.characterIds)
}

describe('deterministic character assignment', () => {
  it('gives one player every scene character', () => {
    const state = room(1)
    startGame(state, 'player-1', characters, 1234)
    expect(state.players[0]?.characterIds).toEqual(characters)
    expect(state).toMatchObject({ status: 'playing', startedAt: 1234 })
  })

  it('assigns one character each when player and character counts are equal', () => {
    const state = room(3)
    startGame(state, 'player-1', characters.slice(0, 3), 1234)
    expect(state.players.map((player) => player.characterIds)).toEqual([
      ['captain'],
      ['sidekick'],
      ['computer'],
    ])
  })

  it('leaves later players unassigned when players outnumber characters', () => {
    const state = room(4)
    startGame(state, 'player-1', characters.slice(0, 2), 1234)
    expect(state.players.map((player) => player.characterIds)).toEqual([
      ['captain'],
      ['sidekick'],
      [],
      [],
    ])
  })

  it('round-robins characters in source and join order when players are fewer', () => {
    const state = room(2)
    startGame(state, 'player-1', characters, 1234)
    expect(state.players.map((player) => player.characterIds)).toEqual([
      ['captain', 'computer', 'narrator'],
      ['sidekick', 'villain'],
    ])
    expect(assigned(state)).toHaveLength(characters.length)
    expect(new Set(assigned(state))).toEqual(new Set(characters))
  })

  it('excludes disconnected players without losing or duplicating characters', () => {
    const state = room(3, [1])
    startGame(state, 'player-1', characters, 1234)
    expect(state.players[1]?.characterIds).toEqual([])
    expect(state.players[0]?.characterIds).toEqual(['captain', 'computer', 'narrator'])
    expect(state.players[2]?.characterIds).toEqual(['sidekick', 'villain'])
    expect(assigned(state).sort()).toEqual([...characters].sort())
  })

  it('is a pure deterministic distribution independent of catalog-specific IDs', () => {
    expect(distributeCharacters(['role-z', 'role-a', 'role-q'], ['p2', 'p1'])).toEqual({
      p2: ['role-z', 'role-q'],
      p1: ['role-a'],
    })
  })
})

describe('server-authoritative game start rules', () => {
  it('rejects non-host and duplicate starts without changing assignments', () => {
    const state = room(2)
    expect(() => startGame(state, 'player-2', characters, 1234)).toThrow('Only the current host')
    expect(assigned(state)).toEqual([])
    startGame(state, 'player-1', characters, 1234)
    const firstAssignments = state.players.map((player) => [...player.characterIds])
    expect(() => startGame(state, 'player-1', characters, 5678)).toThrow('already started')
    expect(state.players.map((player) => player.characterIds)).toEqual(firstAssignments)
    expect(state.startedAt).toBe(1234)
  })

  it('requires at least one connected player and every connected player to be ready', () => {
    const nobody = room(1, [0])
    expect(() => startGame(nobody, 'player-1', characters, 1234)).toThrow('At least one connected')
    const waiting = room(2)
    waiting.players[1]!.ready = false
    expect(() => startGame(waiting, 'player-1', characters, 1234)).toThrow('Every connected player')
    expect(waiting.status).toBe('lobby')
  })
})
