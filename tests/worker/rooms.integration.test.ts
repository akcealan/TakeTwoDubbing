import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import {
  sessionSchema,
  roomSummarySchema,
  MAX_PLAYERS,
  joinRoomRequestSchema,
} from '../../shared/schemas/room'
import {
  serverMessageSchema,
  type RoomSession,
  type ServerMessage,
} from '../../shared/schemas/protocol'
import { MAX_RECORDING_BYTES, recordingUploadResponseSchema } from '../../shared/schemas/recording'
import { resultUploadResponseSchema } from '../../shared/schemas/result'
import type { Room } from '../../shared/types'
import { resolve } from 'node:path'

const origin = 'http://localhost:5173'
let script: string
let runtime: Miniflare
type Socket = NonNullable<Awaited<ReturnType<Miniflare['dispatchFetch']>>['webSocket']>
const sockets: Socket[] = []

function options(ttl = '10800000') {
  return {
    modules: true,
    script,
    compatibilityDate: '2026-07-01',
    durableObjects: {
      ROOMS: { className: 'GameRoom', useSQLite: true },
      SCENE_STUDIO: { className: 'SceneStudio', useSQLite: true },
      MEDIA_STORE: { className: 'MediaStore', useSQLite: true },
    },
    unsafeInspectDurableObjects: true,
    bindings: { ALLOWED_ORIGINS: origin, ROOM_TTL_MS: ttl },
  }
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ['worker/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:*'],
    write: false,
    logLevel: 'silent',
  })
  script = bundle.outputFiles[0]!.text
  runtime = new Miniflare(options())
  await runtime.ready
})
afterAll(async () => {
  for (const socket of sockets) {
    try {
      socket.close()
    } catch {
      /* Already closed by its test. */
    }
  }
  await runtime?.dispose()
})

function post(path: string, body: unknown, target = runtime) {
  return target.dispatchFetch(`http://worker${path}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
}
async function create(nickname = 'Host', target = runtime): Promise<RoomSession> {
  const response = await post('/api/rooms', { sceneId: 'a-small-step', nickname }, target)
  expect(response.status).toBe(201)
  return sessionSchema.parse(await response.json())
}
async function join(session: RoomSession, nickname: string): Promise<RoomSession> {
  const response = await post(`/api/rooms/${session.code}/join`, joinRequest(nickname))
  expect(response.status).toBe(201)
  return sessionSchema.parse(await response.json())
}
function joinRequest(nickname: string) {
  return joinRoomRequestSchema.parse({
    nickname,
    requestId: crypto.randomUUID(),
    requestToken: crypto.randomUUID().replaceAll('-', '').repeat(2),
  })
}
async function start(session: RoomSession, target = runtime) {
  const client = await peer(session, true, target)
  await state(client)
  client.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
  await state(client, (room) => room.players[0]?.ready === true)
  client.socket.send(JSON.stringify({ type: 'START_GAME' }))
  await state(client, (room) => room.status === 'playing')
  return client
}
function upload(
  session: RoomSession,
  lineId: string,
  {
    recordingId = crypto.randomUUID(),
    mimeType = 'audio/webm;codecs=opus',
    durationMs = 1200,
    captureStartMs,
    captureEndMs,
    bytes = validWebm(),
  }: {
    recordingId?: string
    mimeType?: string
    durationMs?: number
    captureStartMs?: number
    captureEndMs?: number
    bytes?: Uint8Array
  } = {},
  target = runtime,
) {
  return target.dispatchFetch(`http://worker/api/rooms/${session.code}/recordings/${lineId}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${session.token}`,
      'Content-Type': mimeType,
      'X-Room-Id': session.roomId,
      'X-Player-Id': session.playerId,
      'X-Recording-Id': recordingId,
      'X-Recording-Duration-Ms': String(durationMs),
      ...(captureStartMs === undefined ? {} : { 'X-Capture-Start-Ms': String(captureStartMs) }),
      ...(captureEndMs === undefined ? {} : { 'X-Capture-End-Ms': String(captureEndMs) }),
      'CF-Connecting-IP': crypto.randomUUID(),
    },
    body: bytes,
  })
}
function validWebm(...payload: number[]) {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...payload])
}
async function mediaAssets(scope: string, target = runtime) {
  const storage = await target.unsafeGetDurableObjectStorage('', 'MediaStore', { name: scope })
  return storage.exec<{
    asset_id: string
    kind: string
    mime_type: string
    byte_size: number
    chunk_count: number
  }>(
    `SELECT asset_id, kind, mime_type, byte_size, chunk_count
     FROM assets WHERE committed = 1 ORDER BY created_at, asset_id`,
  )
}
async function mediaBytes(scope: string, assetId: string, target = runtime) {
  const namespace = await target.getDurableObjectNamespace('MEDIA_STORE')
  const response = await namespace.getByName(scope).fetch(`https://media/assets/${assetId}`)
  return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer())
}
async function deleteMedia(scope: string, assetId: string, target = runtime) {
  const namespace = await target.getDurableObjectNamespace('MEDIA_STORE')
  return namespace.getByName(scope).fetch(`https://media/assets/${assetId}`, { method: 'DELETE' })
}
function renderInput(
  session: RoomSession,
  manifestId: string,
  recordingId: string,
  target = runtime,
) {
  return target.dispatchFetch(
    `http://worker/api/rooms/${session.code}/render-inputs/${encodeURIComponent(recordingId)}`,
    {
      headers: {
        Origin: origin,
        Authorization: `Bearer ${session.token}`,
        'X-Room-Id': session.roomId,
        'X-Player-Id': session.playerId,
        'X-Manifest-Id': manifestId,
        'CF-Connecting-IP': crypto.randomUUID(),
      },
    },
  )
}
function uploadResult(
  session: RoomSession,
  manifestId: string,
  resultId: string,
  {
    mimeType = 'video/mp4',
    bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    token = session.token,
    roomId = session.roomId,
  }: {
    mimeType?: string
    bytes?: Uint8Array
    token?: string
    roomId?: string
  } = {},
  target = runtime,
) {
  return target.dispatchFetch(`http://worker/api/rooms/${session.code}/results/${resultId}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType,
      'X-Room-Id': roomId,
      'X-Player-Id': session.playerId,
      'X-Manifest-Id': manifestId,
      'X-Result-Id': resultId,
      'CF-Connecting-IP': crypto.randomUUID(),
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
  })
}
function getResult(session: RoomSession, manifestId: string, resultId: string, target = runtime) {
  return target.dispatchFetch(`http://worker/api/rooms/${session.code}/results/${resultId}`, {
    headers: {
      Origin: origin,
      Authorization: `Bearer ${session.token}`,
      'X-Room-Id': session.roomId,
      'X-Player-Id': session.playerId,
      'X-Manifest-Id': manifestId,
      'CF-Connecting-IP': crypto.randomUUID(),
    },
  })
}
async function processingRoom(nickname = 'Result Host', target = runtime) {
  const session = await create(nickname, target)
  const client = await start(session, target)
  for (const line of ['step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6'])
    expect((await upload(session, line, {}, target)).status).toBe(201)
  await state(client, (room) => room.recordingProgress?.readyForFinalization === true)
  client.socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
  const room = await state(client, (entry) => entry.status === 'processing')
  return { session, client, room, manifest: room.recordingManifest! }
}
async function peer(session: RoomSession, authenticate = true, target = runtime) {
  const response = await target.dispatchFetch(`http://worker/api/rooms/${session.code}/socket`, {
    headers: { Upgrade: 'websocket', Origin: origin, 'CF-Connecting-IP': crypto.randomUUID() },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket!
  const messages: ServerMessage[] = []
  socket.addEventListener('message', (event) => {
    messages.push(serverMessageSchema.parse(JSON.parse(String(event.data)) as unknown))
  })
  socket.accept()
  sockets.push(socket)
  if (authenticate) socket.send(JSON.stringify({ type: 'AUTH', session }))
  return { socket, messages }
}
type Peer = Awaited<ReturnType<typeof peer>>
async function state(peer: Peer, predicate: (room: Room) => boolean = () => true): Promise<Room> {
  const find = () =>
    peer.messages
      .filter((message) => message.type === 'ROOM_STATE')
      .map((message) => message.payload)
      .reverse()
      .find(predicate)
  await expect.poll(find).toBeDefined()
  return find()!
}
async function error(peer: Peer, code: string) {
  await expect
    .poll(
      () =>
        peer.messages.some((message) => message.type === 'ERROR' && message.payload.code === code),
      { timeout: 5_000 },
    )
    .toBe(true)
}

describe('real Worker + SQLite Durable Object + WebSockets', () => {
  it('stores an owned-line recording privately and broadcasts authoritative metadata', async () => {
    const session = await create('Recording Host')
    const client = await start(session)
    const response = await upload(session, 'step-1', {
      durationMs: 4500,
      captureStartMs: 500,
      captureEndMs: 5000,
    })
    expect(response.status).toBe(201)
    const { recording } = recordingUploadResponseSchema.parse(await response.json())
    expect(recording).toMatchObject({
      lineId: 'step-1',
      playerId: session.playerId,
      mimeType: 'audio/webm;codecs=opus',
      byteSize: 4,
      durationMs: 4500,
      captureStartMs: 500,
      captureEndMs: 5000,
    })
    const room = await state(client, (value) => value.recordings?.[0]?.lineId === 'step-1')
    expect(room.recordings).toEqual([recording])
    expect(JSON.stringify(room)).not.toContain(session.token)
    expect(JSON.stringify(room)).not.toContain('assetId')
    expect(JSON.stringify(room)).not.toContain('objectKey')

    const assets = await mediaAssets(`room:${session.roomId}`)
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({
      kind: 'line-recording',
      mime_type: 'audio/webm;codecs=opus',
      byte_size: 4,
      chunk_count: 1,
    })
    expect(await mediaBytes(`room:${session.roomId}`, assets[0]!.asset_id)).toEqual(validWebm())

    client.socket.close(1000, 'Reconnect metadata test')
    const reconnected = await peer(session)
    expect((await state(reconnected)).recordings).toEqual([recording])
  })

  it('rejects unowned and nonexistent lines using canonical server assignments', async () => {
    const host = await create('Ownership Host')
    const hostPeer = await peer(host)
    await state(hostPeer)
    const guest = await join(host, 'Ownership Guest')
    const guestPeer = await peer(guest)
    await state(guestPeer)
    guestPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(
      hostPeer,
      (room) => room.players.find((p) => p.id === guest.playerId)?.ready === true,
    )
    hostPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(
      hostPeer,
      (room) => room.players.find((p) => p.id === host.playerId)?.ready === true,
    )
    hostPeer.socket.send(JSON.stringify({ type: 'START_GAME' }))
    await state(guestPeer, (room) => room.status === 'playing')

    const unowned = await upload(guest, 'step-1')
    expect(unowned.status).toBe(403)
    expect(await unowned.json()).toMatchObject({ code: 'LINE_NOT_OWNED' })
    const missing = await upload(guest, 'missing-line')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects invalid sessions, lobby uploads, MIME types and oversized bodies', async () => {
    const lobby = await create('Validation Host')
    expect((await upload(lobby, 'step-1')).status).toBe(409)
    const client = await start(lobby)

    const stale = { ...lobby, token: '0'.repeat(64) }
    const invalidSession = await upload(stale, 'step-1')
    expect(invalidSession.status).toBe(401)
    expect(await invalidSession.json()).toMatchObject({ code: 'UNAUTHORIZED' })
    const invalidMime = await upload(lobby, 'step-1', { mimeType: 'application/octet-stream' })
    expect(invalidMime.status).toBe(415)
    expect(await invalidMime.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    const forgedMedia = await upload(lobby, 'step-1', {
      bytes: new Uint8Array([1, 2, 3, 4]),
    })
    expect(forgedMedia.status).toBe(415)
    expect(await forgedMedia.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    const malformedMetadata = await upload(lobby, 'step-1', { durationMs: -1 })
    expect(malformedMetadata.status).toBe(400)
    expect(await malformedMetadata.json()).toMatchObject({ code: 'INVALID_INPUT' })
    const incompleteCapture = await upload(lobby, 'step-1', { captureStartMs: 500 })
    expect(incompleteCapture.status).toBe(400)
    const forgedCapture = await upload(lobby, 'step-1', {
      durationMs: 4500,
      captureStartMs: 0,
      captureEndMs: 4500,
    })
    expect(forgedCapture.status).toBe(400)
    expect(await forgedCapture.json()).toMatchObject({ code: 'INVALID_INPUT' })
    const oversized = await upload(lobby, 'step-1', {
      bytes: new Uint8Array(MAX_RECORDING_BYTES + 1),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
    expect((await state(client)).recordings).toEqual([])
  })

  it('makes duplicate uploads idempotent and safely replaces the previous object', async () => {
    const session = await create('Replacement Host')
    const client = await start(session)
    const firstId = crypto.randomUUID()
    const firstResponse = await upload(session, 'step-1', {
      recordingId: firstId,
      bytes: validWebm(1, 1),
    })
    const first = recordingUploadResponseSchema.parse(await firstResponse.json()).recording
    const duplicateResponse = await upload(session, 'step-1', {
      recordingId: firstId,
      bytes: new Uint8Array([9, 9, 9]),
    })
    expect(duplicateResponse.status).toBe(200)
    expect(recordingUploadResponseSchema.parse(await duplicateResponse.json()).recording).toEqual(
      first,
    )
    const firstAssets = await mediaAssets(`room:${session.roomId}`)
    expect(firstAssets).toHaveLength(1)
    expect(await mediaBytes(`room:${session.roomId}`, firstAssets[0]!.asset_id)).toEqual(
      validWebm(1, 1),
    )

    const replacementResponse = await upload(session, 'step-1', {
      bytes: validWebm(2, 2, 2),
      durationMs: 1800,
    })
    expect(replacementResponse.status).toBe(201)
    const replacement = recordingUploadResponseSchema.parse(
      await replacementResponse.json(),
    ).recording
    await state(client, (room) => room.recordings?.[0]?.recordingId === replacement.recordingId)
    expect(await mediaBytes(`room:${session.roomId}`, firstAssets[0]!.asset_id)).toBeNull()
    const replacementAssets = await mediaAssets(`room:${session.roomId}`)
    expect(replacementAssets).toHaveLength(1)
    expect(await mediaBytes(`room:${session.roomId}`, replacementAssets[0]!.asset_id)).toEqual(
      validWebm(2, 2, 2),
    )
  })

  it('rejects non-host finalization without disconnecting the valid player', async () => {
    const host = await create('Final Host')
    const hostPeer = await peer(host)
    await state(hostPeer)
    const guest = await join(host, 'Final Guest')
    const guestPeer = await peer(guest)
    await state(guestPeer)
    guestPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(
      hostPeer,
      (room) => room.players.find((p) => p.id === guest.playerId)?.ready === true,
    )
    hostPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(
      hostPeer,
      (room) => room.players.find((p) => p.id === host.playerId)?.ready === true,
    )
    hostPeer.socket.send(JSON.stringify({ type: 'START_GAME' }))
    await state(guestPeer, (room) => room.status === 'playing')

    guestPeer.socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
    await error(guestPeer, 'FORBIDDEN')
    guestPeer.socket.send('{"type":"PING"}')
    await expect
      .poll(() => guestPeer.messages.some((message) => message.type === 'PONG'))
      .toBe(true)
  })

  it('freezes one manifest, locks uploads and restores processing state after hibernation', async () => {
    const session = await create('Manifest Host')
    const client = await start(session)
    client.socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
    await error(client, 'RECORDINGS_INCOMPLETE')

    for (const line of ['step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6']) {
      const response = await upload(
        session,
        line,
        line === 'step-1'
          ? { durationMs: 4500, captureStartMs: 500, captureEndMs: 5000 }
          : undefined,
      )
      expect(response.status).toBe(201)
    }
    const ready = await state(
      client,
      (room) => room.recordingProgress?.readyForFinalization === true,
    )
    expect(ready.recordingProgress).toMatchObject({
      totalRequired: 6,
      totalUploaded: 6,
      remaining: 0,
      readyForFinalization: true,
    })
    client.socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
    const processing = await state(client, (room) => room.status === 'processing')
    const manifest = processing.recordingManifest!
    expect(manifest.entries).toHaveLength(6)
    expect(new Set(manifest.entries.map((entry) => entry.lineId)).size).toBe(6)
    expect(manifest.entries[0]).toMatchObject({
      lineId: 'step-1',
      startMs: 1000,
      endMs: 4500,
      captureStartMs: 500,
      captureEndMs: 5000,
    })
    for (const entry of manifest.entries) {
      const source = processing.recordings?.find((recording) => recording.lineId === entry.lineId)
      expect(entry).toMatchObject({
        recordingId: source?.recordingId,
        playerId: source?.playerId,
      })
    }

    const firstEntry = manifest.entries[0]!
    const authorizedRead = await renderInput(session, manifest.manifestId, firstEntry.recordingId)
    expect(authorizedRead.status).toBe(200)
    expect(authorizedRead.headers.get('Cache-Control')).toBe('private, no-store')
    expect(authorizedRead.headers.get('Content-Type')).toBe(firstEntry.mimeType)
    expect(new Uint8Array(await authorizedRead.arrayBuffer())).toEqual(validWebm())

    const arbitraryObjectRead = await renderInput(
      session,
      manifest.manifestId,
      'rooms/another-room/private-object',
    )
    expect(arbitraryObjectRead.status).toBe(400)
    const unlistedRecordingRead = await renderInput(
      session,
      manifest.manifestId,
      crypto.randomUUID(),
    )
    expect(unlistedRecordingRead.status).toBe(404)
    expect(await unlistedRecordingRead.json()).toMatchObject({ code: 'RECORDING_NOT_FOUND' })
    const wrongManifestRead = await renderInput(
      session,
      crypto.randomUUID(),
      firstEntry.recordingId,
    )
    expect(wrongManifestRead.status).toBe(401)

    const storedInputs = await mediaAssets(`room:${session.roomId}`)
    await deleteMedia(`room:${session.roomId}`, storedInputs[0]!.asset_id)
    const missingRecordingRead = await renderInput(
      session,
      manifest.manifestId,
      firstEntry.recordingId,
    )
    expect(missingRecordingRead.status).toBe(404)
    expect(await missingRecordingRead.json()).toMatchObject({ code: 'RECORDING_NOT_FOUND' })
    expect((await state(client)).recordingManifest).toEqual(manifest)

    client.socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
    await error(client, 'FINALIZATION_STARTED')
    const locked = await upload(session, 'step-1')
    expect(locked.status).toBe(409)
    expect(await locked.json()).toMatchObject({ code: 'FINALIZATION_STARTED' })

    await runtime.unsafeEvictDurableObject('', 'GameRoom', {
      name: session.code,
      webSockets: 'hibernate',
    })
    const restored = await peer(session)
    const restoredRoom = await state(restored, (room) => room.status === 'processing')
    expect(restoredRoom.recordingManifest).toEqual(manifest)
    expect(restoredRoom.recordingProgress).toEqual(processing.recordingProgress)
  })

  it('serializes the final-upload versus finalization race without a partial manifest', async () => {
    const session = await create('Race Host')
    const client = await start(session)
    for (const line of ['step-1', 'step-2', 'step-3', 'step-4', 'step-5'])
      expect((await upload(session, line)).status).toBe(201)
    await state(client, (room) => room.recordingProgress?.remaining === 1)

    client.socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
    expect((await upload(session, 'step-6')).status).toBe(201)
    const afterRace = await state(
      client,
      (room) =>
        room.status === 'processing' || room.recordingProgress?.readyForFinalization === true,
    )
    await expect
      .poll(() => {
        const latest = client.messages
          .filter((message) => message.type === 'ROOM_STATE')
          .at(-1)?.payload
        return (
          latest?.status === 'processing' ||
          client.messages.some(
            (message) =>
              message.type === 'ERROR' && message.payload.code === 'RECORDINGS_INCOMPLETE',
          )
        )
      })
      .toBe(true)
    const serialized = client.messages
      .filter((message) => message.type === 'ROOM_STATE')
      .at(-1)?.payload
    if (serialized?.status === 'processing') {
      expect(serialized.recordingManifest?.entries).toHaveLength(6)
    } else {
      expect(
        client.messages.some(
          (message) => message.type === 'ERROR' && message.payload.code === 'RECORDINGS_INCOMPLETE',
        ),
      ).toBe(true)
      client.socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
      expect(
        (await state(client, (room) => room.status === 'processing')).recordingManifest?.entries,
      ).toHaveLength(6)
    }
    expect(
      afterRace.recordingProgress?.readyForFinalization || afterRace.status === 'processing',
    ).toBe(true)
  })

  it('securely commits one idempotent shared result and restores it after hibernation', async () => {
    const { session, client, manifest } = await processingRoom()
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const [firstAttempt, secondAttempt] = await Promise.all([
      uploadResult(session, manifest.manifestId, firstId),
      uploadResult(session, manifest.manifestId, secondId),
    ])
    expect([firstAttempt.status, secondAttempt.status].sort()).toEqual([201, 409])
    const winner =
      firstAttempt.status === 201 ? await firstAttempt.json() : await secondAttempt.json()
    const committed = resultUploadResponseSchema.parse(winner).result
    const finished = await state(client, (room) => room.status === 'finished')
    expect(finished.result).toEqual(committed)
    expect(finished.recordingManifest?.manifestId).toBe(manifest.manifestId)
    const remainingRoomAssets = await mediaAssets(`room:${session.roomId}`)
    expect(remainingRoomAssets).toHaveLength(1)
    expect(remainingRoomAssets[0]).toMatchObject({ kind: 'final-result', byte_size: 8 })

    const retry = await uploadResult(session, manifest.manifestId, committed.resultId)
    expect(retry.status).toBe(200)
    expect(resultUploadResponseSchema.parse(await retry.json()).result).toEqual(committed)
    const replacement = await uploadResult(session, manifest.manifestId, crypto.randomUUID())
    expect(replacement.status).toBe(409)
    expect(await replacement.json()).toMatchObject({ code: 'RESULT_ALREADY_COMMITTED' })

    const download = await getResult(session, manifest.manifestId, committed.resultId)
    expect(download.status).toBe(200)
    expect(download.headers.get('Cache-Control')).toBe('private, no-store')
    expect(download.headers.get('Content-Type')).toBe('video/mp4')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    )
    const resultHead = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/results/${committed.resultId}`,
      {
        method: 'HEAD',
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(resultHead.status).toBe(200)
    expect(resultHead.headers.get('Content-Length')).toBe('8')
    const resultRange = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/results/${committed.resultId}`,
      {
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          Range: 'bytes=4-7',
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(resultRange.status).toBe(206)
    expect(resultRange.headers.get('Content-Range')).toBe('bytes 4-7/8')
    expect(new Uint8Array(await resultRange.arrayBuffer())).toEqual(
      new Uint8Array([102, 116, 121, 112]),
    )

    await runtime.unsafeEvictDurableObject('', 'GameRoom', {
      name: session.code,
      webSockets: 'hibernate',
    })
    const restored = await peer(session)
    const restoredRoom = await state(restored, (room) => room.status === 'finished')
    expect(restoredRoom.result).toEqual(committed)
    expect(restoredRoom.recordingManifest?.manifestId).toBe(manifest.manifestId)
  })

  it('rejects invalid final-result uploads and cross-room retrieval', async () => {
    const early = await create('Early Result')
    const earlyId = crypto.randomUUID()
    expect((await uploadResult(early, crypto.randomUUID(), earlyId)).status).toBe(409)

    const { session, manifest } = await processingRoom('Validation Host')
    const resultId = crypto.randomUUID()
    expect(
      (
        await uploadResult(session, manifest.manifestId, resultId, {
          token: '0'.repeat(64),
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await uploadResult(session, manifest.manifestId, resultId, {
          roomId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(401)
    expect((await uploadResult(session, crypto.randomUUID(), resultId)).status).toBe(401)
    expect(
      (
        await uploadResult(session, manifest.manifestId, resultId, {
          mimeType: 'video/webm',
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await uploadResult(session, manifest.manifestId, resultId, {
          bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        })
      ).status,
    ).toBe(415)

    const empty = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/results/${resultId}`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'video/mp4',
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'X-Manifest-Id': manifest.manifestId,
          'X-Result-Id': resultId,
          'CF-Connecting-IP': crypto.randomUUID(),
          'Content-Length': '0',
        },
        body: new Uint8Array(),
      },
    )
    expect(empty.status).toBe(400)

    const namespace = await runtime.getDurableObjectNamespace('ROOMS')
    const room = namespace.get(namespace.idFromName(session.code))
    const failedCommitId = crypto.randomUUID()
    const authorizationHeaders = {
      Authorization: `Bearer ${session.token}`,
      'X-Room-Id': session.roomId,
      'X-Player-Id': session.playerId,
      'X-Manifest-Id': manifest.manifestId,
      'X-Result-Id': failedCommitId,
    }
    const authorization = await room.fetch(
      `https://room/results/${failedCommitId}/authorize-upload`,
      { method: 'POST', headers: authorizationHeaders },
    )
    expect(authorization.status).toBe(200)
    const pending = (await authorization.json()) as { pending: Record<string, unknown> }
    const failedCommit = await room.fetch(`https://room/results/${failedCommitId}/commit-upload`, {
      method: 'POST',
      headers: {
        ...authorizationHeaders,
        'Content-Type': 'application/json',
        'X-Media-Asset-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({ ...pending.pending, byteSize: 8 }),
    })
    expect(failedCommit.status).toBe(503)
    expect(await mediaAssets(`room:${session.roomId}`)).toHaveLength(manifest.entries.length)

    const committedResponse = await uploadResult(session, manifest.manifestId, resultId)
    const committed = resultUploadResponseSchema.parse(await committedResponse.json()).result
    const other = await create('Other Room')
    expect((await getResult(other, manifest.manifestId, committed.resultId)).status).toBe(404)
  })
  it('creates, joins, broadcasts ready state, transfers host, reconnects and leaves', async () => {
    const host = await create()
    expect(host.code).toMatch(/^\d{6}$/)
    const hostPeer = await peer(host)
    expect((await state(hostPeer)).hostId).toBe(host.playerId)
    const guest = await join(host, 'Guest')
    const guestPeer = await peer(guest)
    await state(
      hostPeer,
      (room) => room.players.length === 2 && room.players.every((player) => player.connected),
    )
    guestPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    const ready = await state(hostPeer, (room) =>
      room.players.some((player) => player.id === guest.playerId && player.ready),
    )
    expect(JSON.stringify(ready)).not.toContain(guest.token)
    expect(JSON.stringify(ready)).not.toContain('tokenHashes')
    expect(ready.status).toBe('lobby')
    expect(ready.players.every((player) => player.characterIds.length === 0)).toBe(true)
    hostPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(
      guestPeer,
      (room) => room.players.find((player) => player.id === host.playerId)?.ready === true,
    )
    hostPeer.socket.close(1000, 'Test disconnect')
    await state(
      guestPeer,
      (room) =>
        room.hostId === guest.playerId &&
        !room.players.find((player) => player.id === host.playerId)?.connected,
    )
    const resumed = await peer(host)
    const resumedState = await state(resumed)
    expect(resumedState.players).toHaveLength(2)
    expect(resumedState.hostId).toBe(guest.playerId)
    expect(resumedState.players.find((player) => player.id === host.playerId)?.ready).toBe(false)
    guestPeer.socket.send(JSON.stringify({ type: 'LEAVE_ROOM' }))
    await state(resumed, (room) => room.players.length === 1 && room.hostId === host.playerId)
    await expect
      .poll(() => guestPeer.messages.some((message) => message.type === 'LEFT_ROOM'))
      .toBe(true)
    const removed = await peer(guest)
    await error(removed, 'UNAUTHORIZED')
    resumed.socket.send(JSON.stringify({ type: 'LEAVE_ROOM' }))
    await expect
      .poll(
        async () => (await runtime.dispatchFetch(`http://worker/api/rooms/${host.code}`)).status,
      )
      .toBe(404)
  })

  it('rejects unauthenticated commands, impersonation and forged client state', async () => {
    const host = await create()
    const unauthenticated = await peer(host, false)
    expect(unauthenticated.messages).toHaveLength(0)
    unauthenticated.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await error(unauthenticated, 'UNAUTHORIZED')
    const forged = await peer({ ...host, token: '0'.repeat(64) })
    await error(forged, 'UNAUTHORIZED')
    const authenticated = await peer(host)
    await state(authenticated)
    for (const message of [
      { type: 'PLAYER_READY', ready: true, playerId: 'someone-else' },
      { type: 'ROOM_STATE', payload: { hostId: 'attacker', status: 'finished' } },
    ]) {
      authenticated.socket.send(JSON.stringify(message))
    }
    await expect
      .poll(
        () =>
          authenticated.messages.filter(
            (message) => message.type === 'ERROR' && message.payload.code === 'INVALID_MESSAGE',
          ).length,
      )
      .toBe(2)
    authenticated.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    const room = await state(authenticated, (room) => room.players[0]?.ready === true)
    expect(room.hostId).toBe(host.playerId)
    expect(room.status).toBe('lobby')
  })

  it('lets only a ready host start once and preserves assignments across reconnect', async () => {
    const host = await create('Start Host')
    const guest = await join(host, 'Start Guest')
    const hostPeer = await peer(host)
    const guestPeer = await peer(guest)
    await state(
      hostPeer,
      (room) => room.players.length === 2 && room.players.every((player) => player.connected),
    )

    guestPeer.socket.send(JSON.stringify({ type: 'START_GAME' }))
    await error(guestPeer, 'FORBIDDEN')
    hostPeer.socket.send(JSON.stringify({ type: 'START_GAME' }))
    await error(hostPeer, 'ROOM_UNAVAILABLE')

    guestPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(
      hostPeer,
      (room) => room.players.find((player) => player.id === guest.playerId)!.ready,
    )
    hostPeer.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(guestPeer, (room) => room.players.every((player) => player.ready))
    hostPeer.socket.send(JSON.stringify({ type: 'START_GAME' }))
    const started = await state(guestPeer, (room) => room.status === 'playing')
    expect(started.startedAt).toEqual(expect.any(Number))
    expect(started.players.find((player) => player.id === host.playerId)?.characterIds).toEqual([
      'nova',
      'echo',
    ])
    expect(started.players.find((player) => player.id === guest.playerId)?.characterIds).toEqual([
      'pip',
    ])
    expect(started.players.flatMap((player) => player.characterIds).sort()).toEqual([
      'echo',
      'nova',
      'pip',
    ])

    const rejectionCount = hostPeer.messages.filter(
      (message) => message.type === 'ERROR' && message.payload.code === 'ROOM_UNAVAILABLE',
    ).length
    hostPeer.socket.send(JSON.stringify({ type: 'START_GAME' }))
    await expect
      .poll(
        () =>
          hostPeer.messages.filter(
            (message) => message.type === 'ERROR' && message.payload.code === 'ROOM_UNAVAILABLE',
          ).length,
      )
      .toBe(rejectionCount + 1)

    hostPeer.socket.close(1000, 'Temporary disconnect')
    const disconnected = await state(
      guestPeer,
      (room) =>
        room.hostId === guest.playerId &&
        !room.players.find((player) => player.id === host.playerId)?.connected,
    )
    expect(disconnected.players.map((player) => player.characterIds)).toEqual(
      started.players.map((player) => player.characterIds),
    )
    const reconnected = await peer(host)
    const restored = await state(reconnected, (room) => room.status === 'playing')
    expect(restored.startedAt).toBe(started.startedAt)
    expect(restored.hostId).toBe(guest.playerId)
    expect(restored.players.map((player) => player.characterIds)).toEqual(
      started.players.map((player) => player.characterIds),
    )
  })

  it('replaces a duplicate session without disconnecting its new socket', async () => {
    const session = await create()
    const first = await peer(session)
    await state(first)
    const second = await peer(session)
    await state(second)
    await error(first, 'SESSION_REPLACED')
    second.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    const room = await state(second, (room) => room.players[0]?.ready === true)
    expect(room.players).toHaveLength(1)
    expect(room.players[0]?.connected).toBe(true)
  })

  it('resolves simultaneous nickname conflicts atomically and enforces capacity', async () => {
    const host = await create()
    const responses = await Promise.all([
      post(`/api/rooms/${host.code}/join`, joinRequest('Guest')),
      post(`/api/rooms/${host.code}/join`, joinRequest('guest')),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    for (let i = 2; i < MAX_PLAYERS; i++) await join(host, `Guest ${i}`)
    const full = await post(`/api/rooms/${host.code}/join`, joinRequest('Extra Guest'))
    expect(full.status).toBe(409)
    expect(await full.json()).toMatchObject({ code: 'ROOM_FULL' })
  })

  it('returns the same session when a successful join response is lost and retried', async () => {
    const host = await create()
    const request = joinRequest('Retry Guest')
    const first = await post(`/api/rooms/${host.code}/join`, request)
    const second = await post(`/api/rooms/${host.code}/join`, request)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const firstSession = sessionSchema.parse(await first.json())
    expect(sessionSchema.parse(await second.json())).toEqual(firstSession)
    const summary = roomSummarySchema.parse(
      await (await runtime.dispatchFetch(`http://worker/api/rooms/${host.code}`)).json(),
    )
    expect(summary.playerCount).toBe(2)

    const tampered = await post(`/api/rooms/${host.code}/join`, {
      ...request,
      requestToken: '0'.repeat(64),
    })
    expect(tampered.status).toBe(401)
  })

  it('reserves a chosen code atomically and refuses to overwrite the existing room', async () => {
    const namespace = await runtime.getDurableObjectNamespace('ROOMS')
    const stub = namespace.get(namespace.idFromName('000001'))
    const reserve = () =>
      stub.fetch('http://room/create?code=000001', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId: 'a-small-step', nickname: 'Owner' }),
      })
    const results = await Promise.all([reserve(), reserve()])
    expect(results.map((response) => response.status).sort()).toEqual([201, 409])
    const created = sessionSchema.parse(
      await results.find((response) => response.status === 201)!.json(),
    )
    const summary = roomSummarySchema.parse(
      await (await runtime.dispatchFetch('http://worker/api/rooms/000001')).json(),
    )
    expect(summary.id).toBe(created.roomId)
    expect(summary.code).toBe('000001')
  })

  it('rejects invalid HTTP inputs, oversized bodies, invalid origins and unsupported methods', async () => {
    expect((await post('/api/rooms', { sceneId: 'missing', nickname: 'Name' })).status).toBe(400)
    expect(
      (await post('/api/rooms', { sceneId: 'a-small-step', nickname: '<script>' })).status,
    ).toBe(400)
    expect(
      (await post('/api/rooms', { sceneId: 'a-small-step', nickname: 'Name', hostId: 'attacker' }))
        .status,
    ).toBe(400)
    expect((await post('/api/rooms/12345/join', { nickname: 'Name' })).status).toBe(400)
    expect((await post('/api/rooms/987654/join', joinRequest('Name'))).status).toBe(404)
    expect((await post('/api/rooms', { padding: 'x'.repeat(5000) })).status).toBe(413)
    expect(
      (
        await runtime.dispatchFetch('http://worker/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400)
    expect(
      (await runtime.dispatchFetch('http://worker/api/rooms/000001', { method: 'DELETE' })).status,
    ).toBe(405)
    expect(
      (
        await runtime.dispatchFetch('http://worker/api/health', {
          headers: { Origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(403)
    const preflight = await runtime.dispatchFetch('http://worker/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: origin },
    })
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    const summary = await runtime.dispatchFetch('http://worker/api/rooms/000001')
    expect(summary.headers.get('Cache-Control')).toBe('no-store')
    expect(summary.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(summary.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(summary.headers.get('X-Frame-Options')).toBe('DENY')
    expect(summary.headers.get('Permissions-Policy')).toContain('microphone=(self)')
    const csp = summary.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).toContain("media-src 'self' blob:")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).toContain('http://127.0.0.1:8765')
    expect(await summary.json()).not.toHaveProperty('players')
  })

  it('limits malformed/binary/oversized WebSocket messages and command flooding', async () => {
    const client = await peer(await create())
    await state(client)
    client.socket.send('{')
    client.socket.send(new ArrayBuffer(8))
    client.socket.send('x'.repeat(5000))
    await expect
      .poll(
        () =>
          client.messages.filter(
            (message) => message.type === 'ERROR' && message.payload.code === 'INVALID_MESSAGE',
          ).length,
      )
      .toBe(3)
    for (let i = 0; i < 30; i++) client.socket.send('{')
    await error(client, 'RATE_LIMITED')
  })

  it('expires and clears room state using the real Durable Object alarm', async () => {
    const shortLived = new Miniflare(options('500'))
    try {
      const session = await create('Temporary', shortLived)
      const client = await peer(session, true, shortLived)
      await state(client)
      await error(client, 'ROOM_NOT_FOUND')
      expect(
        (await shortLived.dispatchFetch(`http://worker/api/rooms/${session.code}`)).status,
      ).toBe(404)
    } finally {
      await shortLived.dispose()
    }
  })

  it('deletes the room MediaStore scope when an uploaded room expires', async () => {
    const shortLived = new Miniflare(options('1500'))
    try {
      const session = await create('Temporary Recording', shortLived)
      const client = await start(session, shortLived)
      const response = await upload(session, 'step-1', {}, shortLived)
      recordingUploadResponseSchema.parse(await response.json())
      expect(await mediaAssets(`room:${session.roomId}`, shortLived)).toHaveLength(1)
      await error(client, 'ROOM_NOT_FOUND')
      await expect.poll(async () => mediaAssets(`room:${session.roomId}`, shortLived)).toEqual([])
    } finally {
      await shortLived.dispose()
    }
  })

  it('deletes a committed final result when its finished room expires', async () => {
    const shortLived = new Miniflare(options('2000'))
    try {
      const { session, client, manifest } = await processingRoom('Temporary Result', shortLived)
      const response = await uploadResult(
        session,
        manifest.manifestId,
        crypto.randomUUID(),
        {},
        shortLived,
      )
      resultUploadResponseSchema.parse(await response.json())
      expect(await mediaAssets(`room:${session.roomId}`, shortLived)).toHaveLength(1)
      await error(client, 'ROOM_NOT_FOUND')
      await expect.poll(async () => mediaAssets(`room:${session.roomId}`, shortLived)).toEqual([])
    } finally {
      await shortLived.dispose()
    }
  })

  it('restores identity and clears stale presence after a persisted Worker restart', async () => {
    const persistentOptions = {
      ...options(),
      durableObjectsPersist: resolve('.tools/worker-tests', crypto.randomUUID()),
    }
    let persistent = new Miniflare(persistentOptions)
    try {
      const session = await create('Persistent', persistent)
      const original = await peer(session, true, persistent)
      await state(original)
      original.socket.close()
      await persistent.dispose()
      persistent = new Miniflare(persistentOptions)
      const restored = await peer(session, true, persistent)
      const room = await state(restored)
      expect(room.id).toBe(session.roomId)
      expect(room.players).toHaveLength(1)
      expect(room.players[0]).toMatchObject({ id: session.playerId, connected: true, ready: false })
    } finally {
      await persistent.dispose()
    }
  })

  it('restores authenticated socket attachments after Durable Object hibernation', async () => {
    const session = await create('Hibernate Host')
    const client = await peer(session)
    await state(client)
    client.socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await state(client, (room) => room.players[0]?.ready === true)
    client.socket.send(JSON.stringify({ type: 'START_GAME' }))
    const started = await state(client, (room) => room.status === 'playing')
    await runtime.unsafeEvictDurableObject('', 'GameRoom', {
      name: session.code,
      webSockets: 'hibernate',
    })
    client.socket.send(JSON.stringify({ type: 'START_GAME' }))
    await error(client, 'ROOM_UNAVAILABLE')
    const restored = await peer(session)
    const restoredState = await state(restored, (room) => room.status === 'playing')
    expect(restoredState.id).toBe(session.roomId)
    expect(restoredState.startedAt).toBe(started.startedAt)
    expect(restoredState.players[0]).toMatchObject({
      id: session.playerId,
      connected: true,
      ready: true,
      characterIds: ['nova', 'pip', 'echo'],
    })
  })
})
