import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomConnection } from './RoomConnection'
import type { RoomSession, ServerMessage } from '../../../shared/schemas/protocol'
import type { Room } from '../../../shared/types'

class FakeSocket {
  static OPEN = 1
  static CLOSING = 2
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  send(message: string) {
    this.sent.push(message)
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const session: RoomSession = {
  code: '012345',
  roomId: crypto.randomUUID(),
  playerId: crypto.randomUUID(),
  token: 'a'.repeat(64),
}
function room(): Room {
  return {
    id: session.roomId,
    code: session.code,
    sceneId: 'a-small-step',
    hostId: session.playerId,
    status: 'lobby',
    startedAt: null,
    players: [
      { id: session.playerId, nickname: 'Kurucu', ready: false, connected: true, characterIds: [] },
    ],
    revision: 1,
    expiresAt: Date.now() + 100000,
  }
}
let connection: RoomConnection
beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  connection = new RoomConnection(session)
})
afterEach(() => {
  connection.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('room reconnect transport', () => {
  it('authenticates privately and waits for a server-confirmed ready update', () => {
    connection.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'AUTH', session })
    socket.message({ type: 'ROOM_STATE', payload: room() })
    connection.send({ type: 'PLAYER_READY', ready: true })
    expect(connection.getSnapshot().pending).toBe(true)
    expect(connection.getSnapshot().room?.players[0]?.ready).toBe(false)
    const ready = room()
    ready.revision = 2
    ready.players[0]!.ready = true
    socket.message({ type: 'ROOM_STATE', payload: ready })
    expect(connection.getSnapshot().pending).toBe(false)
    expect(connection.getSnapshot().room?.players[0]?.ready).toBe(true)
    socket.message({ type: 'ROOM_STATE', payload: room() })
    expect(connection.getSnapshot().room?.revision).toBe(2)
  })
  it('sends a payload-free start command and waits for the playing snapshot', () => {
    connection.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.message({ type: 'ROOM_STATE', payload: room() })
    connection.send({ type: 'START_GAME' })
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'START_GAME' })
    expect(connection.getSnapshot().pending).toBe(true)
    const playing = room()
    playing.status = 'playing'
    playing.startedAt = 1234
    playing.revision = 2
    playing.players[0]!.characterIds = ['nova', 'pip', 'echo']
    socket.message({ type: 'ROOM_STATE', payload: playing })
    expect(connection.getSnapshot()).toMatchObject({ pending: false, room: playing })
  })
  it('reconnects with the same identity after an unexpected close', () => {
    connection.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.message({ type: 'ROOM_STATE', payload: room() })
    first.close(1006)
    expect(connection.getSnapshot().status).toBe('reconnecting')
    vi.advanceTimersByTime(800)
    const second = FakeSocket.instances[1]!
    second.open()
    expect(JSON.parse(second.sent[0]!)).toEqual({ type: 'AUTH', session })
    second.message({ type: 'ROOM_STATE', payload: room() })
    expect(connection.getSnapshot().status).toBe('connected')
  })
  it('recognizes an expired saved session after a failed WebSocket handshake', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: 'ROOM_NOT_FOUND', message: 'Room expired.' }, { status: 404 }),
        ),
    )
    connection.connect()
    FakeSocket.instances[0]!.close(1006)
    await vi.waitFor(() => expect(connection.getSnapshot().terminal).toBe(true))
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(connection.getSnapshot()).toMatchObject({
      status: 'closed',
      error: 'Bu odanın süresi doldu. Yeni bir oda oluştur veya başka bir odaya katıl.',
    })
  })
  it('stops an old session when its room code now belongs to a different room', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: crypto.randomUUID(),
          code: session.code,
          sceneId: 'a-small-step',
          status: 'lobby',
          startedAt: null,
          expiresAt: Date.now() + 10_000,
          playerCount: 1,
        }),
      ),
    )
    connection.connect()
    FakeSocket.instances[0]!.close(1006)
    await vi.waitFor(() => expect(connection.getSnapshot().terminal).toBe(true))
    expect(connection.getSnapshot().error).toContain('yeni bir oda için yeniden kullanılmış')
  })
  it('detects a silent half-open connection with heartbeat timeout', () => {
    connection.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.message({ type: 'ROOM_STATE', payload: room() })
    vi.advanceTimersByTime(45_000)
    expect(first.sent).toContain('{"type":"PING"}')
    expect(first.readyState).toBe(3)
    expect(connection.getSnapshot().status).toBe('reconnecting')
  })
  it('bounds repeated network reconnects and permits a manual retry', () => {
    connection.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.message({ type: 'ROOM_STATE', payload: room() })
    for (let attempt = 0; attempt < 7; attempt++) {
      FakeSocket.instances.at(-1)!.close(1006)
      vi.advanceTimersByTime(9_000)
    }
    expect(connection.getSnapshot()).toMatchObject({
      status: 'disconnected',
      pending: false,
      terminal: false,
    })
    const count = FakeSocket.instances.length
    connection.connect()
    expect(FakeSocket.instances).toHaveLength(count + 1)
    expect(connection.getSnapshot().status).toBe('connecting')
  })
  it('stops reconnecting after a terminal session replacement', () => {
    connection.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.message({
      type: 'ERROR',
      payload: { code: 'SESSION_REPLACED', message: 'Use the other tab.' },
    })
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(connection.getSnapshot()).toMatchObject({
      terminal: true,
      status: 'closed',
      error: 'Oturumun başka bir bağlantıda açıldı. Devam etmek için yeniden katıl.',
    })
  })
  it('recovers if a command is not acknowledged', () => {
    connection.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.message({ type: 'ROOM_STATE', payload: room() })
    connection.send({ type: 'PLAYER_READY', ready: true })
    vi.advanceTimersByTime(8000)
    expect(socket.readyState).toBe(3)
    expect(connection.getSnapshot()).toMatchObject({ pending: false, status: 'reconnecting' })
  })
  it('rejects server state for a different room and stops on disposal', () => {
    connection.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.message({ type: 'ROOM_STATE', payload: { ...room(), id: crypto.randomUUID() } })
    expect(connection.getSnapshot().terminal).toBe(true)
    connection.connect()
    connection.dispose()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
