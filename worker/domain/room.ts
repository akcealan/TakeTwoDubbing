import { MAX_PLAYERS, nicknameSchema } from '../../shared/schemas/room'
import type { Player, Room } from '../../shared/types'
import { RoomError } from './errors'

export function newPlayer(id: string, nickname: string): Player {
  return {
    id,
    nickname: nicknameSchema.parse(nickname),
    connected: false,
    ready: false,
    characterIds: [],
  }
}

export function addPlayer(room: Room, player: Player): void {
  if (room.status !== 'lobby')
    throw new RoomError('ROOM_UNAVAILABLE', 'This room is no longer accepting players.', 409)
  if (
    room.players.some(
      (existing) =>
        existing.nickname.normalize('NFKC').toLowerCase() ===
        player.nickname.normalize('NFKC').toLowerCase(),
    )
  ) {
    throw new RoomError(
      'NICKNAME_TAKEN',
      'That nickname is already in this room. Try another one.',
      409,
    )
  }
  if (room.players.length >= MAX_PLAYERS)
    throw new RoomError('ROOM_FULL', `This room has reached its ${MAX_PLAYERS}-player limit.`, 409)
  room.players.push(player)
}

export function updatePresence(room: Room, playerId: string, connected: boolean): void {
  const player = requirePlayer(room, playerId)
  player.connected = connected
  if (!connected) player.ready = false
  chooseHost(room)
}

export function chooseHost(room: Room): void {
  const host = room.players.find((player) => player.id === room.hostId)
  if (host?.connected) return
  room.hostId =
    room.players.find((player) => player.connected)?.id ?? host?.id ?? room.players[0]?.id ?? ''
}

export function removePlayer(room: Room, playerId: string): void {
  room.players = room.players.filter((player) => player.id !== playerId)
  chooseHost(room)
}

export function setReady(room: Room, playerId: string, ready: boolean): void {
  const player = requirePlayer(room, playerId)
  if (room.status !== 'lobby' || !player.connected)
    throw new RoomError(
      'ROOM_UNAVAILABLE',
      'Reconnect to the lobby before changing your ready state.',
      409,
    )
  player.ready = ready
}

export function distributeCharacters(
  characterIds: readonly string[],
  playerIds: readonly string[],
): Record<string, string[]> {
  const assignments = Object.fromEntries(playerIds.map((playerId) => [playerId, [] as string[]]))
  if (!playerIds.length) return assignments
  characterIds.forEach((characterId, index) => {
    assignments[playerIds[index % playerIds.length]!]!.push(characterId)
  })
  return assignments
}

export function startGame(
  room: Room,
  requesterId: string,
  characterIds: readonly string[],
  startedAt: number,
): void {
  if (room.status !== 'lobby' || room.startedAt !== null)
    throw new RoomError('ROOM_UNAVAILABLE', 'This game has already started.', 409)
  const requester = requirePlayer(room, requesterId)
  if (room.hostId !== requester.id)
    throw new RoomError('FORBIDDEN', 'Only the current host can start the game.', 403)
  const connectedPlayers = room.players.filter((player) => player.connected)
  if (!connectedPlayers.length)
    throw new RoomError('ROOM_UNAVAILABLE', 'At least one connected player is required.', 409)
  if (!connectedPlayers.every((player) => player.ready))
    throw new RoomError('ROOM_UNAVAILABLE', 'Every connected player must be ready.', 409)
  if (
    !characterIds.length ||
    new Set(characterIds).size !== characterIds.length ||
    characterIds.some((characterId) => !characterId)
  )
    throw new RoomError('ROOM_UNAVAILABLE', 'The selected scene has invalid characters.', 409)
  if (!Number.isSafeInteger(startedAt) || startedAt < 0)
    throw new RoomError('ROOM_UNAVAILABLE', 'The game start time is invalid.', 409)

  const assignments = distributeCharacters(
    characterIds,
    connectedPlayers.map((player) => player.id),
  )
  for (const player of room.players) player.characterIds = assignments[player.id] ?? []
  room.status = 'playing'
  room.startedAt = startedAt
}

function requirePlayer(room: Room, playerId: string): Player {
  const player = room.players.find((entry) => entry.id === playerId)
  if (!player)
    throw new RoomError('UNAUTHORIZED', 'Your room session is no longer valid. Join again.', 401)
  return player
}
