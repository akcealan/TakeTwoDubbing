import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import {
  preparationDraftResponseSchema,
  sceneListResponseSchema,
} from '../../shared/schemas/studio'
import { sessionSchema } from '../../shared/schemas/room'
import { sceneSchema } from '../../shared/schemas/scene'
import { recordingManifestSchema } from '../../shared/schemas/recording'
import type { Room } from '../../shared/types'

const origin = 'http://localhost:5173'
const token = 'a'.repeat(64)
const otherToken = 'b'.repeat(64)
let runtime: Miniflare
let video: Uint8Array

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
  runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2026-07-01',
    durableObjects: {
      ROOMS: { className: 'GameRoom', useSQLite: true },
      SCENE_STUDIO: { className: 'SceneStudio', useSQLite: true },
      MEDIA_STORE: { className: 'MediaStore', useSQLite: true },
    },
    unsafeInspectDurableObjects: true,
    bindings: { ALLOWED_ORIGINS: origin, ROOM_TTL_MS: '10800000' },
  })
  await runtime.ready
  video = new Uint8Array(await readFile('public/scenes/a-small-step/video.webm'))
})

afterAll(async () => runtime?.dispose())

async function mediaAssets(scope: string) {
  const storage = await runtime.unsafeGetDurableObjectStorage('', 'MediaStore', { name: scope })
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

async function mediaBytes(scope: string, assetId: string) {
  const namespace = await runtime.getDurableObjectNamespace('MEDIA_STORE')
  const response = await namespace.getByName(scope).fetch(`https://media/assets/${assetId}`)
  return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer())
}

function studio(
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string | ArrayBuffer | Uint8Array
  } = {},
  accessToken = token,
) {
  const requestHeaders: Record<string, string> = {
    ...options.headers,
    Origin: origin,
    Authorization: `Bearer ${accessToken}`,
    'CF-Connecting-IP': crypto.randomUUID(),
  }
  return runtime.dispatchFetch(`http://worker/api/private-scenes${path}`, {
    ...options,
    headers: requestHeaders,
  })
}

describe('private Scene Studio Worker and SQLite MediaStore flow', () => {
  it('rejects empty, unsupported and forged video uploads', async () => {
    const unsupported = await studio('/upload', {
      method: 'POST',
      headers: uploadHeaders('video/quicktime'),
      body: video.buffer as ArrayBuffer,
    })
    expect(unsupported.status).toBe(415)
    const empty = await studio('/upload', {
      method: 'POST',
      headers: uploadHeaders('video/webm'),
      body: new Uint8Array(),
    })
    expect(empty.status).toBe(400)
    const forged = await studio('/upload', {
      method: 'POST',
      headers: uploadHeaders('video/webm'),
      body: new Uint8Array([1, 2, 3, 4]),
    })
    expect(forged.status).toBe(400)
  })

  it('uploads, prepares, versions and safely deletes a playable private scene', async () => {
    const uploadedResponse = await studio('/upload', {
      method: 'POST',
      headers: uploadHeaders('video/webm'),
      body: video.buffer as ArrayBuffer,
    })
    expect(uploadedResponse.status).toBe(201)
    const uploaded = preparationDraftResponseSchema.parse(await uploadedResponse.json()).draft
    expect(uploaded.media).toMatchObject({
      filename: 'original.webm',
      durationMs: 30_000,
      width: 640,
      height: 360,
    })
    const firstThumbnail = webp(640, 360, 1)
    expect(
      (
        await studio(`/${uploaded.media.sceneId}/thumbnail`, {
          method: 'POST',
          headers: thumbnailHeaders(),
          body: firstThumbnail,
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await studio(
          `/${uploaded.media.sceneId}/thumbnail`,
          { method: 'POST', headers: thumbnailHeaders(), body: firstThumbnail },
          otherToken,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await studio(`/${uploaded.media.sceneId}/thumbnail`, {
          method: 'POST',
          headers: { ...thumbnailHeaders(), 'Content-Type': 'image/png' },
          body: firstThumbnail,
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await studio(`/${uploaded.media.sceneId}/thumbnail`, {
          method: 'POST',
          headers: thumbnailHeaders(),
          body: new Uint8Array([1, 2, 3, 4]),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await studio(`/${uploaded.media.sceneId}/thumbnail`, {
          method: 'POST',
          headers: thumbnailHeaders(),
          body: new Uint8Array(512 * 1024 + 1),
        })
      ).status,
    ).toBe(413)

    const scene = sceneSchema.parse({
      id: uploaded.media.sceneId,
      title: 'Bizim Sahne',
      description: 'Özel test sahnesi',
      durationMs: 30_000,
      videoUrl: `/api/private-scenes/${uploaded.media.sceneId}/source`,
      genre: 'Custom',
      difficulty: 'Prepared',
      accent: 'violet',
      mediaStatus: 'available',
      sourceAudioStatus: 'unknown',
      contentCredit: 'İzinli özgün test içeriği.',
      origin: { kind: 'private', version: 1, sourceFileName: 'original.webm' },
      characters: [
        { id: 'ada', name: 'Ada' },
        { id: 'bora', name: 'Bora' },
      ],
      lines: [
        { id: 'line-1', characterId: 'ada', text: 'Merhaba', startMs: 1000, endMs: 3000 },
        { id: 'line-2', characterId: 'bora', text: 'Aynı anda', startMs: 2000, endMs: 4000 },
      ],
    })
    const savedResponse = await studio(`/${scene.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene }),
    })
    expect(savedResponse.status).toBe(200)
    const saved = preparationDraftResponseSchema.parse(await savedResponse.json()).draft
    expect(saved.status).toBe('prepared')
    expect(saved.scene?.origin.version).toBe(1)
    expect(saved.scene?.thumbnailUrl).toBe(`/api/private-scenes/${scene.id}/thumbnail`)
    expect(saved.thumbnail).toMatchObject({
      mimeType: 'image/webp',
      width: 640,
      height: 360,
      capturedAtMs: 4500,
    })
    const fetchedThumbnail = await studio(`/${scene.id}/thumbnail`)
    expect(fetchedThumbnail.status).toBe(200)
    expect(fetchedThumbnail.headers.get('Cache-Control')).toBe('private, max-age=300')
    expect(new Uint8Array(await fetchedThumbnail.arrayBuffer())).toEqual(firstThumbnail)
    expect((await studio(`/${scene.id}/thumbnail`, {}, otherToken)).status).toBe(404)

    const firstBackground = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 77, 52, 65, 32, 1])
    const backgroundResponse = await studio(`/${scene.id}/background`, {
      method: 'POST',
      headers: backgroundHeaders(),
      body: firstBackground,
    })
    expect(backgroundResponse.status).toBe(201)
    const withBackground = preparationDraftResponseSchema.parse(
      await backgroundResponse.json(),
    ).draft
    expect(withBackground.backgroundAudio).toMatchObject({
      mimeType: 'audio/mp4',
      durationMs: 30_000,
      sampleRate: 44_100,
      channels: 2,
    })
    expect(withBackground.scene?.backgroundAudioUrl).toBe(
      `/api/private-scenes/${scene.id}/background`,
    )
    expect(withBackground.scene?.origin.version).toBe(2)
    expect(
      (
        await studio(
          `/${scene.id}/background`,
          { method: 'POST', headers: backgroundHeaders(), body: firstBackground },
          otherToken,
        )
      ).status,
    ).toBe(404)
    expect(new Uint8Array(await (await studio(`/${scene.id}/background`)).arrayBuffer())).toEqual(
      firstBackground,
    )
    const secondThumbnail = webp(640, 360, 2)
    const thumbnailReplacement = preparationDraftResponseSchema.parse(
      await (
        await studio(`/${scene.id}/thumbnail`, {
          method: 'POST',
          headers: { ...thumbnailHeaders(), 'X-Thumbnail-Object-Key': 'forged/key.webp' },
          body: secondThumbnail,
        })
      ).json(),
    ).draft
    expect(thumbnailReplacement.thumbnail?.id).not.toBe(saved.thumbnail?.id)
    expect(
      (await mediaAssets(`scene:${scene.id}`)).filter((asset) => asset.kind === 'scene-thumbnail'),
    ).toHaveLength(1)
    expect(new Uint8Array(await (await studio(`/${scene.id}/thumbnail`)).arrayBuffer())).toEqual(
      secondThumbnail,
    )
    expect(
      (await mediaAssets(`scene:${scene.id}`)).filter((asset) => asset.kind === 'scene-background'),
    ).toHaveLength(1)

    const rejectedReplacement = await studio(`/${scene.id}/background`, {
      method: 'POST',
      headers: { ...backgroundHeaders(), 'X-Background-Duration-Ms': '29000' },
      body: new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 77, 52, 65, 32, 9]),
    })
    expect(rejectedReplacement.status).toBe(400)
    expect(new Uint8Array(await (await studio(`/${scene.id}/background`)).arrayBuffer())).toEqual(
      firstBackground,
    )
    expect(
      preparationDraftResponseSchema.parse(await (await studio(`/${scene.id}`)).json()).draft
        .backgroundAudio?.id,
    ).toBe(withBackground.backgroundAudio?.id)

    const listResponse = await studio('')
    expect(sceneListResponseSchema.parse(await listResponse.json()).scenes[0]?.title).toBe(
      'Bizim Sahne',
    )
    expect((await studio(`/${scene.id}/source`, {}, otherToken)).status).toBe(404)
    expect((await studio(`/${scene.id}/source`)).status).toBe(200)
    const sourceHead = await studio(`/${scene.id}/source`, { method: 'HEAD' })
    expect(sourceHead.status).toBe(200)
    expect(sourceHead.headers.get('Content-Length')).toBe(String(video.byteLength))
    expect((await sourceHead.arrayBuffer()).byteLength).toBe(0)
    const sourceRange = await studio(`/${scene.id}/source`, {
      headers: { Range: 'bytes=0-3' },
    })
    expect(sourceRange.status).toBe(206)
    expect(sourceRange.headers.get('Content-Range')).toBe(`bytes 0-3/${video.byteLength}`)
    expect(new Uint8Array(await sourceRange.arrayBuffer())).toEqual(video.slice(0, 4))

    const roomResponse = await runtime.dispatchFetch('http://worker/api/rooms', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Scene-Authorization': `Bearer ${token}`,
        'CF-Connecting-IP': crypto.randomUUID(),
      },
      body: JSON.stringify({ sceneId: scene.id, nickname: 'Host' }),
    })
    expect(roomResponse.status).toBe(201)
    const session = sessionSchema.parse(await roomResponse.json())

    const secondBackground = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 77, 52, 65, 32, 2])
    const replacement = preparationDraftResponseSchema.parse(
      await (
        await studio(`/${scene.id}/background`, {
          method: 'POST',
          headers: {
            ...backgroundHeaders(),
            'X-Background-Object-Key': 'rooms/forged/background.m4a',
          },
          body: secondBackground,
        })
      ).json(),
    ).draft
    expect(replacement.backgroundAudio?.id).not.toBe(withBackground.backgroundAudio?.id)
    expect(replacement.scene?.origin.version).toBe(3)
    const replacementSceneAssets = (await mediaAssets(`scene:${scene.id}`)).filter(
      (asset) => asset.kind === 'scene-background',
    )
    expect(replacementSceneAssets).toHaveLength(1)
    expect(await mediaBytes(`scene:${scene.id}`, replacementSceneAssets[0]!.asset_id)).toEqual(
      secondBackground,
    )

    const secondRoomResponse = await runtime.dispatchFetch('http://worker/api/rooms', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Scene-Authorization': `Bearer ${token}`,
        'CF-Connecting-IP': crypto.randomUUID(),
      },
      body: JSON.stringify({ sceneId: scene.id, nickname: 'Second Host' }),
    })
    expect(secondRoomResponse.status).toBe(201)
    const secondSession = sessionSchema.parse(await secondRoomResponse.json())
    const secondRoomBackground = (await mediaAssets(`room:${secondSession.roomId}`)).find(
      (asset) => asset.kind === 'room-background',
    )!
    expect(await mediaBytes(`room:${secondSession.roomId}`, secondRoomBackground.asset_id)).toEqual(
      secondBackground,
    )
    const edited = {
      ...scene,
      title: 'Düzeltilmiş Sahne',
      characters: [{ id: 'ada', name: 'Ada' }],
      lines: [{ ...scene.lines[0]! }],
    }
    const editResponse = await studio(`/${scene.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: edited }),
    })
    expect(
      preparationDraftResponseSchema.parse(await editResponse.json()).draft.scene?.origin.version,
    ).toBe(4)
    expect((await studio(`/${scene.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(sceneListResponseSchema.parse(await (await studio('')).json()).scenes).toHaveLength(0)
    const firstRoomBackground = (await mediaAssets(`room:${session.roomId}`)).find(
      (asset) => asset.kind === 'room-background',
    )!
    expect(await mediaBytes(`room:${session.roomId}`, firstRoomBackground.asset_id)).toEqual(
      firstBackground,
    )
    expect(await mediaBytes(`room:${secondSession.roomId}`, secondRoomBackground.asset_id)).toEqual(
      secondBackground,
    )
    expect(await mediaAssets(`scene:${scene.id}`)).toEqual([])

    const socketResponse = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/socket`,
      {
        headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': crypto.randomUUID() },
      },
    )
    const socket = socketResponse.webSocket!
    socket.accept()
    const roomMessages: Room[] = []
    const roomState = new Promise<Room>((resolveState) => {
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string
          payload?: Room
        }
        if (message.type === 'ROOM_STATE' && message.payload) {
          roomMessages.push(message.payload)
          resolveState(message.payload)
        }
      })
    })
    socket.send(JSON.stringify({ type: 'AUTH', session }))
    const snapshottedRoom = await roomState
    expect(snapshottedRoom.sceneSnapshot?.title).toBe('Bizim Sahne')
    expect(snapshottedRoom.sceneSnapshot?.characters).toHaveLength(2)
    expect(snapshottedRoom.sceneSnapshot?.backgroundAudioUrl).toBe(
      `/api/rooms/${session.code}/render-background`,
    )
    expect(snapshottedRoom.sceneSnapshot?.thumbnailUrl).toBeUndefined()

    const roomSource = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/source-video`,
      {
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(roomSource.status).toBe(200)
    expect(new Uint8Array(await roomSource.arrayBuffer())).toEqual(video)
    const roomSourceRange = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/source-video`,
      {
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          Range: 'bytes=-5',
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(roomSourceRange.status).toBe(206)
    expect(new Uint8Array(await roomSourceRange.arrayBuffer())).toEqual(video.slice(-5))
    const forgedRoomSource = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/source-video`,
      {
        headers: {
          Origin: origin,
          Authorization: `Bearer ${'0'.repeat(64)}`,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(forgedRoomSource.status).toBe(401)

    socket.send(JSON.stringify({ type: 'PLAYER_READY', ready: true }))
    await expect.poll(() => roomMessages.at(-1)?.players[0]?.ready).toBe(true)
    socket.send(JSON.stringify({ type: 'START_GAME' }))
    await expect.poll(() => roomMessages.at(-1)?.status).toBe('playing')
    for (const line of scene.lines) {
      const recording = await runtime.dispatchFetch(
        `http://worker/api/rooms/${session.code}/recordings/${line.id}`,
        {
          method: 'POST',
          headers: {
            Origin: origin,
            Authorization: `Bearer ${session.token}`,
            'Content-Type': 'audio/webm;codecs=opus',
            'X-Room-Id': session.roomId,
            'X-Player-Id': session.playerId,
            'X-Recording-Id': crypto.randomUUID(),
            'X-Recording-Duration-Ms': '1200',
            'CF-Connecting-IP': crypto.randomUUID(),
          },
          body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
        },
      )
      expect(recording.status).toBe(201)
    }
    await expect.poll(() => roomMessages.at(-1)?.recordingProgress?.readyForFinalization).toBe(true)
    socket.send(JSON.stringify({ type: 'FINALIZE_RECORDINGS' }))
    await expect.poll(() => roomMessages.at(-1)?.status).toBe('processing')
    const manifest = recordingManifestSchema.parse(roomMessages.at(-1)?.recordingManifest)
    expect(manifest.backgroundAudioUrl).toBe(`/api/rooms/${session.code}/render-background`)

    const frozenBackground = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/render-background`,
      {
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'X-Manifest-Id': manifest.manifestId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(frozenBackground.status).toBe(200)
    expect(new Uint8Array(await frozenBackground.arrayBuffer())).toEqual(firstBackground)
    const forgedBackground = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/render-background`,
      {
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'X-Manifest-Id': crypto.randomUUID(),
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(forgedBackground.status).toBe(401)

    const resultId = crypto.randomUUID()
    const resultBytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
    const resultUpload = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/results/${resultId}`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(resultBytes.byteLength),
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'X-Manifest-Id': manifest.manifestId,
          'X-Result-Id': resultId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
        body: resultBytes,
      },
    )
    expect(resultUpload.status).toBe(201)
    await expect.poll(() => roomMessages.at(-1)?.status).toBe('finished')
    const postFinalAssets = await mediaAssets(`room:${session.roomId}`)
    expect(postFinalAssets).toHaveLength(1)
    expect(postFinalAssets[0]).toMatchObject({ kind: 'final-result', byte_size: 8 })
    const resultRead = await runtime.dispatchFetch(
      `http://worker/api/rooms/${session.code}/results/${resultId}`,
      {
        headers: {
          Origin: origin,
          Authorization: `Bearer ${session.token}`,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      },
    )
    expect(resultRead.status).toBe(200)
    expect(new Uint8Array(await resultRead.arrayBuffer())).toEqual(resultBytes)
    socket.close()
  })
})

function uploadHeaders(type: string) {
  return {
    'Content-Type': type,
    'X-Scene-Filename': encodeURIComponent('original.webm'),
    'X-Scene-Duration-Ms': '30000',
    'X-Scene-Width': '640',
    'X-Scene-Height': '360',
  }
}

function backgroundHeaders() {
  return {
    'Content-Type': 'audio/mp4',
    'X-Background-Duration-Ms': '30000',
    'X-Background-Sample-Rate': '44100',
    'X-Background-Channels': '2',
    'X-Background-Provider': encodeURIComponent('local-cinematic-separator'),
    'X-Background-Provider-Version': encodeURIComponent('1'),
    'X-Background-Model': encodeURIComponent('fixture-separator'),
    'X-Background-Device': 'cpu',
  }
}

function thumbnailHeaders() {
  return {
    'Content-Type': 'image/webp',
    'X-Thumbnail-Width': '640',
    'X-Thumbnail-Height': '360',
    'X-Thumbnail-Captured-At-Ms': '4500',
  }
}

function webp(width: number, height: number, marker: number) {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBP'), 8)
  bytes.set(new TextEncoder().encode('VP8X'), 12)
  bytes[16] = 10
  bytes[20] = marker
  const encodedWidth = width - 1
  const encodedHeight = height - 1
  bytes[24] = encodedWidth & 0xff
  bytes[25] = (encodedWidth >> 8) & 0xff
  bytes[26] = (encodedWidth >> 16) & 0xff
  bytes[27] = encodedHeight & 0xff
  bytes[28] = (encodedHeight >> 8) & 0xff
  bytes[29] = (encodedHeight >> 16) & 0xff
  return bytes
}
