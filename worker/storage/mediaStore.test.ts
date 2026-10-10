import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'

const MEDIA_CHUNK_BYTES = 1024 * 1024

let runtime: Miniflare
let namespace: Awaited<ReturnType<Miniflare['getDurableObjectNamespace']>>

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
    bindings: { ALLOWED_ORIGINS: 'http://localhost:5173', ROOM_TTL_MS: '10800000' },
    unsafeInspectDurableObjects: true,
  })
  await runtime.ready
  namespace = await runtime.getDurableObjectNamespace('MEDIA_STORE')
})

afterAll(async () => runtime?.dispose(), 60_000)

function bytes(size: number, marker = 7) {
  const value = new Uint8Array(size)
  value.set([0x1a, 0x45, 0xdf, 0xa3])
  for (let index = 4; index < size; index++) value[index] = (index + marker) % 251
  return value
}

function stub(scope: string) {
  return namespace.getByName(scope)
}

async function upload(
  scope: string,
  body: Uint8Array | ReadableStream<Uint8Array>,
  kind = 'scene-source',
  mimeType = 'video/webm',
  declaredLength?: number,
) {
  const headers = new Headers({ 'Content-Type': mimeType, 'X-Media-Kind': kind })
  if (declaredLength !== undefined) headers.set('Content-Length', String(declaredLength))
  return stub(scope).fetch('https://media/assets', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit)
}

async function assetRows(scope: string) {
  const storage = await runtime.unsafeGetDurableObjectStorage('', 'MediaStore', { name: scope })
  return storage.exec<{
    asset_id: string
    kind: string
    mime_type: string
    byte_size: number
    chunk_count: number
    committed: number
  }>(
    `SELECT asset_id, kind, mime_type, byte_size, chunk_count, committed
     FROM assets ORDER BY created_at, asset_id`,
  )
}

async function chunkRows(scope: string) {
  const storage = await runtime.unsafeGetDurableObjectStorage('', 'MediaStore', { name: scope })
  return storage.exec<{ asset_id: string; chunk_index: number; byte_size: number }>(
    `SELECT asset_id, chunk_index, length(bytes) AS byte_size
     FROM asset_chunks ORDER BY asset_id, chunk_index`,
  )
}

describe('SQLite MediaStore core', () => {
  it('rejects empty assets without committing metadata or chunks', async () => {
    const scope = 'scene:private-000000000001'
    const response = await upload(scope, new Uint8Array())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'empty' })
    expect(await assetRows(scope)).toEqual([])
    expect(await chunkRows(scope)).toEqual([])
  })

  it('stores one chunk with authoritative metadata and serves full GET/HEAD', async () => {
    const scope = 'scene:private-000000000002'
    const original = bytes(128)
    const response = await upload(
      scope,
      original,
      'scene-source',
      'video/webm',
      original.byteLength,
    )
    expect(response.status).toBe(201)
    const asset = (await response.json()) as {
      assetId: string
      kind: string
      mimeType: string
      byteSize: number
      chunkCount: number
    }
    expect(asset).toMatchObject({
      kind: 'scene-source',
      mimeType: 'video/webm',
      byteSize: 128,
      chunkCount: 1,
    })
    expect(await assetRows(scope)).toEqual([
      expect.objectContaining({
        asset_id: asset.assetId,
        kind: 'scene-source',
        mime_type: 'video/webm',
        byte_size: 128,
        chunk_count: 1,
        committed: 1,
      }),
    ])
    const get = await stub(scope).fetch(`https://media/assets/${asset.assetId}`)
    expect(get.status).toBe(200)
    expect(get.headers.get('Content-Type')).toBe('video/webm')
    expect(get.headers.get('Content-Length')).toBe('128')
    expect(get.headers.get('Accept-Ranges')).toBe('bytes')
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(original)
    const head = await stub(scope).fetch(`https://media/assets/${asset.assetId}`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe('128')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  it('stores exact boundaries, multiple chunks, and a last short chunk', async () => {
    const exactScope = 'scene:private-000000000003'
    const exact = bytes(MEDIA_CHUNK_BYTES)
    const exactAsset = (await (
      await upload(exactScope, exact, 'scene-source', 'video/webm', exact.byteLength)
    ).json()) as { assetId: string }
    expect(await chunkRows(exactScope)).toEqual([
      {
        asset_id: exactAsset.assetId,
        chunk_index: 0,
        byte_size: MEDIA_CHUNK_BYTES,
      },
    ])

    const multiScope = 'scene:private-000000000004'
    const multi = bytes(MEDIA_CHUNK_BYTES * 2 + 37)
    const multiAsset = (await (
      await upload(multiScope, multi, 'scene-source', 'video/webm', multi.byteLength)
    ).json()) as { assetId: string; chunkCount: number }
    expect(multiAsset.chunkCount).toBe(3)
    expect((await chunkRows(multiScope)).map((row) => row.byte_size)).toEqual([
      MEDIA_CHUNK_BYTES,
      MEDIA_CHUNK_BYTES,
      37,
    ])
    const get = await stub(multiScope).fetch(`https://media/assets/${multiAsset.assetId}`)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(multi)
  })

  it('serves ranges inside and across chunks, on boundaries, and at final bytes', async () => {
    const scope = 'scene:private-000000000005'
    const original = bytes(MEDIA_CHUNK_BYTES * 2 + 11)
    const asset = (await (
      await upload(scope, original, 'scene-source', 'video/webm', original.byteLength)
    ).json()) as { assetId: string }
    const range = async (value: string) => {
      const response = await stub(scope).fetch(`https://media/assets/${asset.assetId}`, {
        headers: { Range: value },
      })
      return { response, body: new Uint8Array(await response.arrayBuffer()) }
    }

    const inside = await range('bytes=20-39')
    expect(inside.response.status).toBe(206)
    expect(inside.response.headers.get('Content-Range')).toBe(`bytes 20-39/${original.byteLength}`)
    expect(inside.body).toEqual(original.slice(20, 40))

    const crossing = await range(`bytes=${MEDIA_CHUNK_BYTES - 3}-${MEDIA_CHUNK_BYTES + 4}`)
    expect(crossing.body).toEqual(original.slice(MEDIA_CHUNK_BYTES - 3, MEDIA_CHUNK_BYTES + 5))

    const exactEnd = await range(`bytes=0-${MEDIA_CHUNK_BYTES - 1}`)
    expect(exactEnd.body).toEqual(original.slice(0, MEDIA_CHUNK_BYTES))
    const exactStart = await range(`bytes=${MEDIA_CHUNK_BYTES}-${MEDIA_CHUNK_BYTES * 2 - 1}`)
    expect(exactStart.body).toEqual(original.slice(MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES * 2))

    const final = await range('bytes=-5')
    expect(final.body).toEqual(original.slice(-5))
    const invalid = await stub(scope).fetch(`https://media/assets/${asset.assetId}`, {
      headers: { Range: `bytes=${original.byteLength}-` },
    })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('Content-Range')).toBe(`bytes */${original.byteLength}`)
  })

  it('streams the full 64 MiB final-result ceiling as 64 bounded rows', async () => {
    const scope = `room:${crypto.randomUUID()}`
    const totalBytes = 64 * MEDIA_CHUNK_BYTES
    let index = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === 64) {
          controller.close()
          return
        }
        const chunk = new Uint8Array(MEDIA_CHUNK_BYTES)
        chunk.fill(index)
        if (index === 0) chunk.set([0x66, 0x74, 0x79, 0x70], 4)
        controller.enqueue(chunk)
        index++
      },
    })
    const response = await upload(scope, stream, 'final-result', 'video/mp4', totalBytes)
    expect(response.status).toBe(201)
    const asset = (await response.json()) as {
      assetId: string
      byteSize: number
      chunkCount: number
    }
    expect(asset).toMatchObject({ byteSize: totalBytes, chunkCount: 64 })
    const rows = await chunkRows(scope)
    expect(rows).toHaveLength(64)
    expect(new Set(rows.map((row) => row.byte_size))).toEqual(new Set([MEDIA_CHUNK_BYTES]))
    const final = await stub(scope).fetch(`https://media/assets/${asset.assetId}`, {
      headers: { Range: 'bytes=-4' },
    })
    expect(final.status).toBe(206)
    expect(new Uint8Array(await final.arrayBuffer())).toEqual(new Uint8Array([63, 63, 63, 63]))
    await stub(scope).fetch('https://media/assets', { method: 'DELETE' })
    expect(await assetRows(scope)).toEqual([])
  }, 120_000)

  it('rejects oversized and interrupted uploads without partial committed storage', async () => {
    const oversizedScope = 'scene:private-000000000006'
    const oversized = new Uint8Array(512 * 1024 + 1)
    oversized.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    const oversizedResponse = await upload(
      oversizedScope,
      oversized,
      'scene-thumbnail',
      'image/webp',
    )
    expect(oversizedResponse.status).toBe(413)
    expect(await assetRows(oversizedScope)).toEqual([])
    expect(await chunkRows(oversizedScope)).toEqual([])

    const interruptedScope = 'scene:private-000000000007'
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(MEDIA_CHUNK_BYTES))
        controller.error(new Error('intentional interruption'))
      },
    })
    await expect(upload(interruptedScope, interrupted)).rejects.toThrow()
    expect(await assetRows(interruptedScope)).toEqual([])
    expect(await chunkRows(interruptedScope)).toEqual([])
  })

  it('deletes one asset and cleans an entire scope efficiently', async () => {
    const scope = 'scene:private-000000000008'
    const first = (await (await upload(scope, bytes(20))).json()) as { assetId: string }
    await upload(scope, bytes(21, 9))
    expect(await assetRows(scope)).toHaveLength(2)
    expect(
      (await stub(scope).fetch(`https://media/assets/${first.assetId}`, { method: 'DELETE' }))
        .status,
    ).toBe(204)
    expect(await assetRows(scope)).toHaveLength(1)
    expect(await chunkRows(scope)).toHaveLength(1)
    expect((await stub(scope).fetch('https://media/assets', { method: 'DELETE' })).status).toBe(204)
    expect(await assetRows(scope)).toEqual([])
    expect(await chunkRows(scope)).toEqual([])
  })

  it('copies between scopes as a bounded stream with byte-for-byte equality', async () => {
    const sourceScope = 'scene:private-000000000009'
    const destinationScope = `room:${crypto.randomUUID()}`
    const original = bytes(MEDIA_CHUNK_BYTES + 29)
    const sourceAsset = (await (
      await upload(sourceScope, original, 'scene-source', 'video/webm', original.byteLength)
    ).json()) as { assetId: string }
    const sourceResponse = await stub(sourceScope).fetch(
      `https://media/assets/${sourceAsset.assetId}`,
    )
    const copiedResponse = await upload(
      destinationScope,
      sourceResponse.body!,
      'room-source',
      sourceResponse.headers.get('Content-Type')!,
      Number(sourceResponse.headers.get('Content-Length')),
    )
    expect(copiedResponse.status).toBe(201)
    const copied = (await copiedResponse.json()) as { assetId: string; chunkCount: number }
    expect(copied.chunkCount).toBe(2)
    const copiedRead = await stub(destinationScope).fetch(`https://media/assets/${copied.assetId}`)
    expect(new Uint8Array(await copiedRead.arrayBuffer())).toEqual(original)
    expect((await assetRows(sourceScope))[0]?.kind).toBe('scene-source')
    expect((await assetRows(destinationScope))[0]?.kind).toBe('room-source')
  })
})
