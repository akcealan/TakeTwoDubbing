import { afterEach, expect, it, vi } from 'vitest'
import { createJoinRoomRequest, createRoom, getRoomSummary, uploadLineRecording } from './rooms'
import type { LocalLineRecording } from '../recording/localRecording'

const session = {
  code: '012345',
  roomId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002',
  token: 'a'.repeat(64),
}
const localRecording: LocalLineRecording = {
  recordingId: '00000000-0000-4000-8000-000000000003',
  lineId: 'step-1',
  playerId: session.playerId,
  startMs: 1000,
  endMs: 4500,
  captureStartMs: 500,
  captureEndMs: 5000,
  durationMs: 4500,
  mimeType: 'audio/webm;codecs=opus',
  blob: new Blob(['voice'], { type: 'audio/webm;codecs=opus' }),
  objectUrl: 'blob:local-preview',
}

afterEach(() => vi.unstubAllGlobals())

it('handles the empty Vite proxy failure when the local Worker is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
  await expect(createRoom('a-small-step', 'Deniz')).rejects.toMatchObject({
    code: 'SERVER_ERROR',
    message: 'Oda servisi şu anda kullanılamıyor. Lütfen tekrar dene.',
  })
})

it('rejects a successful HTTP response with invalid room data', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: '123' })))
  await expect(createRoom('a-small-step', 'Deniz')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  })
})

it('creates unique, validated credentials for an idempotent join', () => {
  const first = createJoinRoomRequest('  Deniz  ')
  const second = createJoinRoomRequest('Deniz')
  expect(first.nickname).toBe('Deniz')
  expect(first.requestId).not.toBe(second.requestId)
  expect(first.requestToken).toMatch(/^[a-f0-9]{64}$/)
})

it('maps a missing room summary to the Turkish terminal error code', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: 'ROOM_NOT_FOUND', message: 'Room expired.' }, { status: 404 }),
      ),
  )
  await expect(getRoomSummary('012345')).rejects.toMatchObject({
    code: 'ROOM_NOT_FOUND',
    message: 'Oda bulunamadı veya süresi doldu. Oda kodunu kontrol et.',
  })
})

it('uploads raw audio with anonymous credentials in headers and validates metadata', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json(
      {
        recording: {
          recordingId: localRecording.recordingId,
          lineId: localRecording.lineId,
          playerId: session.playerId,
          mimeType: localRecording.mimeType,
          byteSize: localRecording.blob.size,
          durationMs: localRecording.durationMs,
          captureStartMs: localRecording.captureStartMs,
          captureEndMs: localRecording.captureEndMs,
          uploadedAt: 1234,
        },
      },
      { status: 201 },
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const stored = await uploadLineRecording(session, localRecording)
  expect(stored.recordingId).toBe(localRecording.recordingId)
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
  expect(url.pathname).toBe('/api/rooms/012345/recordings/step-1')
  expect(url.toString()).not.toContain(session.token)
  expect(init.body).toBe(localRecording.blob)
  expect(init.headers).toMatchObject({
    Authorization: `Bearer ${session.token}`,
    'Content-Type': 'audio/webm;codecs=opus',
    'X-Room-Id': session.roomId,
    'X-Player-Id': session.playerId,
    'X-Recording-Id': localRecording.recordingId,
    'X-Recording-Duration-Ms': '4500',
    'X-Capture-Start-Ms': '500',
    'X-Capture-End-Ms': '5000',
  })
})

it('keeps a local recording retryable when upload is rejected', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: 'UPLOAD_FAILED', message: 'Storage failed.' }, { status: 503 }),
      ),
  )
  await expect(uploadLineRecording(session, localRecording)).rejects.toMatchObject({
    code: 'UPLOAD_FAILED',
    message: 'Ses kaydı geçici depoya kaydedilemedi. Yerel kayıt duruyor; tekrar dene.',
  })
  expect(localRecording.blob.size).toBeGreaterThan(0)
  expect(localRecording.objectUrl).toBe('blob:local-preview')
})
