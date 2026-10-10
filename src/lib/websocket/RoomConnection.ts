import {
  serverMessageSchema,
  type ClientMessage,
  type RoomSession,
} from '../../../shared/schemas/protocol'
import type { Room } from '../../../shared/types'
import { ApiError, apiUrl, getRoomSummary } from '../api/rooms'
import { roomErrorMessages } from '../rooms/errorMessages'

export interface ConnectionSnapshot {
  room: Room | null
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed'
  error: string | null
  terminal: boolean
  left: boolean
  pending: boolean
}

export class RoomConnection {
  private snapshot: ConnectionSnapshot = {
    room: null,
    status: 'connecting',
    error: null,
    terminal: false,
    left: false,
    pending: false,
  }
  private readonly listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private retryTimer?: ReturnType<typeof setTimeout>
  private connectTimer?: ReturnType<typeof setTimeout>
  private commandTimer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private attempts = 0
  private active = false
  private lastMessageAt = 0

  constructor(private readonly session: RoomSession) {}
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<ConnectionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  connect = (): void => {
    this.dispose()
    this.active = true
    this.attempts = 0
    this.update({ status: 'connecting', error: null, terminal: false, left: false, pending: false })
    this.open()
  }

  private open(): void {
    if (!this.active) return
    let socket: WebSocket
    try {
      const url = apiUrl(`/api/rooms/${this.session.code}/socket`)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url)
    } catch {
      this.update({
        error: 'Canlı bağlantı kurulamadı. Lütfen tekrar dene.',
      })
      this.retry()
      return
    }
    this.socket = socket
    this.lastMessageAt = Date.now()
    this.connectTimer = setTimeout(() => {
      if (this.socket === socket) socket.close(4000, 'Connection timeout')
    }, 12_000)
    socket.onopen = () => {
      if (this.socket !== socket || !this.active) return
      socket.send(JSON.stringify({ type: 'AUTH', session: this.session } satisfies ClientMessage))
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessageAt >= 45_000) {
          socket.close(4000, 'Connection lost')
          return
        }
        if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"PING"}')
      }, 15_000)
    }
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket || !this.active) return
      this.lastMessageAt = Date.now()
      let value: unknown
      try {
        if (typeof event.data !== 'string' || event.data.length > 64_000)
          throw new Error('Invalid message')
        value = JSON.parse(event.data) as unknown
      } catch {
        this.invalidMessage(socket)
        return
      }
      const message = serverMessageSchema.safeParse(value)
      if (!message.success) {
        this.invalidMessage(socket)
        return
      }
      switch (message.data.type) {
        case 'ROOM_STATE': {
          const room = message.data.payload
          if (
            room.id !== this.session.roomId ||
            room.code !== this.session.code ||
            !room.players.some((player) => player.id === this.session.playerId)
          ) {
            this.invalidMessage(socket)
            return
          }
          clearTimeout(this.connectTimer)
          clearTimeout(this.commandTimer)
          this.attempts = 0
          if (this.snapshot.room && room.revision < this.snapshot.room.revision) return
          this.update({ room, status: 'connected', pending: false, error: null })
          break
        }
        case 'ERROR': {
          clearTimeout(this.commandTimer)
          const terminal = ['UNAUTHORIZED', 'ROOM_NOT_FOUND', 'SESSION_REPLACED'].includes(
            message.data.payload.code,
          )
          this.update({
            error: roomErrorMessages[message.data.payload.code],
            terminal,
            pending: false,
          })
          if (terminal) {
            this.active = false
            this.clearTimers()
            socket.close()
            this.update({ status: 'closed' })
          }
          break
        }
        case 'LEFT_ROOM':
          this.active = false
          this.clearTimers()
          this.update({ left: true, status: 'closed', pending: false })
          socket.close()
          break
        case 'PONG':
          break
      }
    }
    socket.onerror = () => {
      if (this.socket === socket && this.active)
        this.update({ error: 'Canlı bağlantı kesildi. Yeniden bağlanılıyor…' })
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.clearTimers()
      this.socket = null
      if (!this.active) return
      if ([4401, 4404, 4409].includes(event.code)) {
        this.active = false
        this.update({
          status: 'closed',
          terminal: true,
          pending: false,
          error:
            event.code === 4404
              ? 'Bu odanın süresi doldu. Yeni bir oda oluştur.'
              : 'Oturumun sona erdi. Devam etmek için yeniden katıl.',
        })
      } else if (!this.snapshot.room) {
        this.update({
          status: 'reconnecting',
          pending: false,
          error: 'Bağlantı kesildi. Odanın durumu kontrol ediliyor…',
        })
        void this.classifyClose()
      } else this.retry()
    }
  }

  private async classifyClose(): Promise<void> {
    try {
      const summary = await getRoomSummary(this.session.code)
      if (!this.active || this.socket) return
      if (summary.id !== this.session.roomId) {
        this.endSession(
          'Oda kodu yeni bir oda için yeniden kullanılmış. Devam etmek için odaya yeniden katıl.',
        )
        return
      }
    } catch (error) {
      if (!this.active || this.socket) return
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') {
        this.endSession('Bu odanın süresi doldu. Yeni bir oda oluştur veya başka bir odaya katıl.')
        return
      }
    }
    if (this.active && !this.socket) this.retry()
  }

  private endSession(error: string): void {
    this.active = false
    this.clearTimers()
    this.update({ status: 'closed', terminal: true, pending: false, error })
  }

  private invalidMessage(socket: WebSocket) {
    this.update({
      error: 'Oda servisinden geçersiz bir güncelleme geldi. Lütfen yeniden bağlan.',
      terminal: true,
      status: 'closed',
      pending: false,
    })
    this.active = false
    this.clearTimers()
    socket.close(1002, 'Invalid server message')
  }
  private retry() {
    if (!this.active) return
    this.attempts++
    if (this.attempts > 6) {
      this.update({
        status: 'disconnected',
        pending: false,
        error: 'Bağlantı kesildi. İnternet bağlantını kontrol edip yeniden dene.',
      })
      return
    }
    this.update({
      status: 'reconnecting',
      pending: false,
      error: 'Bağlantı kesildi. Odana yeniden bağlanılıyor…',
    })
    this.retryTimer = setTimeout(
      () => this.open(),
      Math.min(500 * 2 ** (this.attempts - 1), 8000) + Math.floor(Math.random() * 250),
    )
  }
  send = (
    message: Extract<
      ClientMessage,
      { type: 'PLAYER_READY' | 'START_GAME' | 'FINALIZE_RECORDINGS' | 'LEAVE_ROOM' }
    >,
  ): void => {
    if (
      this.snapshot.status !== 'connected' ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.snapshot.pending
    )
      return
    try {
      this.socket.send(JSON.stringify(message))
      this.update({ pending: true, error: null })
      this.commandTimer = setTimeout(() => {
        this.update({
          pending: false,
          error:
            'Değişiklik onaylanamadı. Odanın durumunu kontrol etmek için yeniden bağlanılıyor…',
        })
        this.socket?.close(4000, 'Command acknowledgement timeout')
      }, 8000)
    } catch {
      this.update({
        pending: false,
        error: 'Değişiklik gönderilemedi. Yeniden bağlanıp tekrar dene.',
      })
      this.socket.close()
    }
  }
  private clearTimers() {
    clearTimeout(this.retryTimer)
    clearTimeout(this.connectTimer)
    clearTimeout(this.commandTimer)
    clearInterval(this.heartbeat)
  }
  dispose = (): void => {
    this.active = false
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Page closed')
  }
}
