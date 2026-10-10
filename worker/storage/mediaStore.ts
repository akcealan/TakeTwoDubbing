import { DurableObject } from 'cloudflare:workers'
import { ALLOWED_RECORDING_MIME_TYPES, MAX_RECORDING_BYTES } from '../../shared/schemas/recording'
import { FINAL_RESULT_MIME_TYPE, MAX_FINAL_RESULT_BYTES } from '../../shared/schemas/result'
import {
  ALLOWED_PRIVATE_VIDEO_TYPES,
  ALLOWED_THUMBNAIL_TYPES,
  BACKGROUND_AUDIO_MIME_TYPE,
  MAX_BACKGROUND_AUDIO_BYTES,
  MAX_PRIVATE_SCENE_BYTES,
  MAX_THUMBNAIL_BYTES,
} from '../../shared/schemas/studio'
import type { Env } from '../types/env'

export const MEDIA_CHUNK_BYTES = 1024 * 1024

export const MEDIA_KINDS = [
  'scene-source',
  'scene-background',
  'scene-thumbnail',
  'room-source',
  'room-background',
  'line-recording',
  'final-result',
] as const

export type MediaKind = (typeof MEDIA_KINDS)[number]

export interface MediaAsset {
  assetId: string
  kind: MediaKind
  mimeType: string
  byteSize: number
  chunkCount: number
  createdAt: number
}

interface AssetRow extends Record<string, SqlStorageValue> {
  asset_id: string
  kind: string
  mime_type: string
  byte_size: number
  chunk_count: number
  created_at: number
}

interface ChunkRow extends Record<string, SqlStorageValue> {
  bytes: ArrayBuffer
}

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const MEDIA_POLICIES: Record<MediaKind, { maximumBytes: number; mimeTypes: readonly string[] }> = {
  'scene-source': {
    maximumBytes: MAX_PRIVATE_SCENE_BYTES,
    mimeTypes: ALLOWED_PRIVATE_VIDEO_TYPES,
  },
  'scene-background': {
    maximumBytes: MAX_BACKGROUND_AUDIO_BYTES,
    mimeTypes: [BACKGROUND_AUDIO_MIME_TYPE],
  },
  'scene-thumbnail': {
    maximumBytes: MAX_THUMBNAIL_BYTES,
    mimeTypes: ALLOWED_THUMBNAIL_TYPES,
  },
  'room-source': {
    maximumBytes: MAX_PRIVATE_SCENE_BYTES,
    mimeTypes: ALLOWED_PRIVATE_VIDEO_TYPES,
  },
  'room-background': {
    maximumBytes: MAX_BACKGROUND_AUDIO_BYTES,
    mimeTypes: [BACKGROUND_AUDIO_MIME_TYPE],
  },
  'line-recording': {
    maximumBytes: MAX_RECORDING_BYTES,
    mimeTypes: ALLOWED_RECORDING_MIME_TYPES,
  },
  'final-result': {
    maximumBytes: MAX_FINAL_RESULT_BYTES,
    mimeTypes: [FINAL_RESULT_MIME_TYPE],
  },
}

export class MediaStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS assets (
        asset_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
        chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
        created_at INTEGER NOT NULL,
        committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS asset_chunks (
        asset_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        bytes BLOB NOT NULL CHECK (length(bytes) > 0 AND length(bytes) <= ${MEDIA_CHUNK_BYTES}),
        PRIMARY KEY (asset_id, chunk_index),
        FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS asset_chunks_asset_index
        ON asset_chunks(asset_id, chunk_index);
    `)
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        // A terminated upload can leave only uncommitted rows. No read path exposes them.
        this.deleteIncompleteAssets()
        const url = new URL(request.url)
        if (url.pathname === '/assets' && request.method === 'POST')
          return await this.upload(request)
        if (url.pathname === '/assets' && request.method === 'DELETE') {
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec('DELETE FROM asset_chunks')
            this.ctx.storage.sql.exec('DELETE FROM assets')
          })
          return new Response(null, { status: 204 })
        }
        if (url.pathname === '/assets/retain' && request.method === 'POST') {
          const retained = await readRetainedAssetIds(request)
          this.ctx.storage.transactionSync(() => {
            if (retained.length === 0) {
              this.ctx.storage.sql.exec('DELETE FROM asset_chunks')
              this.ctx.storage.sql.exec('DELETE FROM assets')
            } else {
              const placeholders = retained.map(() => '?').join(', ')
              this.ctx.storage.sql.exec(
                `DELETE FROM asset_chunks WHERE asset_id NOT IN (${placeholders})`,
                ...retained,
              )
              this.ctx.storage.sql.exec(
                `DELETE FROM assets WHERE asset_id NOT IN (${placeholders})`,
                ...retained,
              )
            }
          })
          return new Response(null, { status: 204 })
        }
        const match = /^\/assets\/([0-9a-f-]+)$/i.exec(url.pathname)
        if (!match || !ASSET_ID.test(match[1]!)) return mediaError('not-found', 404)
        const assetId = match[1]!
        if (request.method === 'GET' || request.method === 'HEAD')
          return this.read(assetId, request.method, request.headers.get('Range'))
        if (request.method === 'DELETE') {
          this.deleteAsset(assetId)
          return new Response(null, { status: 204 })
        }
        return mediaError('method-not-allowed', 405)
      } catch (error) {
        if (error instanceof MediaStoreError) return mediaError(error.reason, error.status)
        console.error(
          'MediaStore request failed',
          error instanceof Error ? error.message : 'Unknown error',
        )
        return mediaError('storage-failed', 500)
      }
    })
  }

  private async upload(request: Request): Promise<Response> {
    const kind = parseKind(request.headers.get('X-Media-Kind'))
    const mimeType = request.headers.get('Content-Type') ?? ''
    const policy = MEDIA_POLICIES[kind]
    if (!policy.mimeTypes.includes(mimeType)) throw new MediaStoreError('unsupported-media', 415)
    const declared = parseOptionalLength(request.headers.get('Content-Length'))
    if (declared !== undefined && declared > policy.maximumBytes)
      throw new MediaStoreError('too-large', 413)
    if (!request.body) throw new MediaStoreError('empty', 400)

    const assetId = crypto.randomUUID()
    const createdAt = Date.now()
    this.ctx.storage.sql.exec(
      `INSERT INTO assets
        (asset_id, kind, mime_type, byte_size, chunk_count, created_at, committed)
       VALUES (?, ?, ?, 0, 0, ?, 0)`,
      assetId,
      kind,
      mimeType,
      createdAt,
    )

    const reader = request.body.getReader()
    const chunk = new Uint8Array(MEDIA_CHUNK_BYTES)
    const prefix = new Uint8Array(12)
    let prefixLength = 0
    let chunkLength = 0
    let chunkIndex = 0
    let byteSize = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        let offset = 0
        while (offset < part.value.byteLength) {
          const take = Math.min(MEDIA_CHUNK_BYTES - chunkLength, part.value.byteLength - offset)
          const slice = part.value.subarray(offset, offset + take)
          chunk.set(slice, chunkLength)
          if (prefixLength < prefix.byteLength) {
            const prefixTake = Math.min(prefix.byteLength - prefixLength, slice.byteLength)
            prefix.set(slice.subarray(0, prefixTake), prefixLength)
            prefixLength += prefixTake
          }
          chunkLength += take
          byteSize += take
          offset += take
          if (byteSize > policy.maximumBytes) {
            await reader.cancel().catch(() => undefined)
            throw new MediaStoreError('too-large', 413)
          }
          if (chunkLength === MEDIA_CHUNK_BYTES) {
            this.insertChunk(assetId, chunkIndex++, chunk)
            chunkLength = 0
          }
        }
      }
      if (byteSize === 0) throw new MediaStoreError('empty', 400)
      validateSignature(prefix, prefixLength, mimeType)
      if (chunkLength) this.insertChunk(assetId, chunkIndex++, chunk.subarray(0, chunkLength))
      if (declared !== undefined && declared !== byteSize)
        throw new MediaStoreError('length-mismatch', 400)

      this.ctx.storage.transactionSync(() => {
        const totals = this.ctx.storage.sql
          .exec<{ count: number; bytes: number }>(
            `SELECT count(*) AS count, coalesce(sum(length(bytes)), 0) AS bytes
             FROM asset_chunks WHERE asset_id = ?`,
            assetId,
          )
          .one()
        if (totals.count !== chunkIndex || totals.bytes !== byteSize)
          throw new MediaStoreError('storage-failed', 500)
        this.ctx.storage.sql.exec(
          `UPDATE assets SET byte_size = ?, chunk_count = ?, committed = 1
           WHERE asset_id = ? AND committed = 0`,
          byteSize,
          chunkIndex,
          assetId,
        )
      })
      return Response.json(
        {
          assetId,
          kind,
          mimeType,
          byteSize,
          chunkCount: chunkIndex,
          createdAt,
        } satisfies MediaAsset,
        { status: 201 },
      )
    } catch (error) {
      this.deleteAsset(assetId)
      throw error
    } finally {
      reader.releaseLock()
    }
  }

  private read(assetId: string, method: string, rangeHeader: string | null): Response {
    const row = this.ctx.storage.sql
      .exec<AssetRow>(
        `SELECT asset_id, kind, mime_type, byte_size, chunk_count, created_at
         FROM assets WHERE asset_id = ? AND committed = 1`,
        assetId,
      )
      .toArray()[0]
    if (!row) return mediaError('not-found', 404)
    const range = parseRange(rangeHeader, row.byte_size)
    if (range === 'invalid')
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${row.byte_size}`,
          'Content-Length': '0',
        },
      })
    const start = range?.start ?? 0
    const end = range?.end ?? row.byte_size - 1
    const length = end - start + 1
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': row.mime_type,
      'Content-Length': String(length),
      'X-Media-Asset-Id': row.asset_id,
      'X-Media-Kind': row.kind,
      'X-Media-Created-At': String(row.created_at),
      'X-Media-Chunk-Count': String(row.chunk_count),
      'X-Media-Total-Bytes': String(row.byte_size),
    })
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${row.byte_size}`)
    let body: ReadableStream<Uint8Array> | null = null
    if (method !== 'HEAD') {
      const fixed = new FixedLengthStream(length)
      this.ctx.waitUntil(
        this.assetStream(assetId, start, end, row.chunk_count).pipeTo(fixed.writable),
      )
      body = fixed.readable
    }
    return new Response(body, { status: range ? 206 : 200, headers })
  }

  private assetStream(
    assetId: string,
    start: number,
    end: number,
    chunkCount: number,
  ): ReadableStream<Uint8Array> {
    let chunkIndex = Math.floor(start / MEDIA_CHUNK_BYTES)
    const lastChunk = Math.floor(end / MEDIA_CHUNK_BYTES)
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (chunkIndex > lastChunk || chunkIndex >= chunkCount) {
          controller.close()
          return
        }
        const row = this.ctx.storage.sql
          .exec<ChunkRow>(
            'SELECT bytes FROM asset_chunks WHERE asset_id = ? AND chunk_index = ?',
            assetId,
            chunkIndex,
          )
          .toArray()[0]
        if (!row) {
          controller.error(new Error('Committed media chunk is missing'))
          return
        }
        const bytes = new Uint8Array(row.bytes)
        const absoluteStart = chunkIndex * MEDIA_CHUNK_BYTES
        const from =
          chunkIndex === Math.floor(start / MEDIA_CHUNK_BYTES) ? start - absoluteStart : 0
        const to = chunkIndex === lastChunk ? end - absoluteStart + 1 : bytes.byteLength
        controller.enqueue(bytes.subarray(from, to))
        chunkIndex++
      },
    })
  }

  private insertChunk(assetId: string, chunkIndex: number, bytes: Uint8Array) {
    this.ctx.storage.sql.exec(
      'INSERT INTO asset_chunks (asset_id, chunk_index, bytes) VALUES (?, ?, ?)',
      assetId,
      chunkIndex,
      bytes,
    )
  }

  private deleteIncompleteAssets() {
    this.ctx.storage.sql.exec('DELETE FROM assets WHERE committed = 0')
  }

  private deleteAsset(assetId: string) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM asset_chunks WHERE asset_id = ?', assetId)
      this.ctx.storage.sql.exec('DELETE FROM assets WHERE asset_id = ?', assetId)
    })
  }
}

export class MediaStoreClient {
  private readonly stub: DurableObjectStub

  constructor(
    namespace: DurableObjectNamespace,
    readonly scope: string,
  ) {
    if (!/^(?:scene:private-[a-f0-9]{12}|room:[0-9a-f-]{36})$/i.test(scope))
      throw new Error('Invalid media scope')
    this.stub = namespace.getByName(scope)
  }

  async put(
    body: ReadableStream<Uint8Array>,
    kind: MediaKind,
    mimeType: string,
    expectedBytes?: number,
  ): Promise<MediaAsset> {
    const headers = new Headers({ 'Content-Type': mimeType, 'X-Media-Kind': kind })
    if (expectedBytes !== undefined) headers.set('Content-Length', String(expectedBytes))
    const response = await this.stub.fetch(
      new Request('https://media/assets', { method: 'POST', headers, body }),
    )
    if (!response.ok) throw await MediaStoreError.fromResponse(response)
    return (await response.json()) as MediaAsset
  }

  read(assetId: string, method: 'GET' | 'HEAD' = 'GET', range?: string | null) {
    return this.stub.fetch(
      new Request(`https://media/assets/${assetId}`, {
        method,
        headers: range ? { Range: range } : undefined,
      }),
    )
  }

  async metadata(assetId: string): Promise<MediaAsset | null> {
    const response = await this.read(assetId, 'HEAD')
    if (response.status === 404) return null
    if (!response.ok) throw await MediaStoreError.fromResponse(response)
    return assetFromHeaders(response.headers)
  }

  async delete(assetId: string): Promise<void> {
    const response = await this.stub.fetch(`https://media/assets/${assetId}`, { method: 'DELETE' })
    if (!response.ok) throw await MediaStoreError.fromResponse(response)
  }

  async cleanup(): Promise<void> {
    const response = await this.stub.fetch('https://media/assets', { method: 'DELETE' })
    if (!response.ok) throw await MediaStoreError.fromResponse(response)
  }

  async retainOnly(assetIds: string[]): Promise<void> {
    if (assetIds.some((assetId) => !ASSET_ID.test(assetId)))
      throw new Error('Invalid media asset ID')
    const response = await this.stub.fetch('https://media/assets/retain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds }),
    })
    if (!response.ok) throw await MediaStoreError.fromResponse(response)
  }
}

export async function copyMediaAsset(
  namespace: DurableObjectNamespace,
  sourceScope: string,
  sourceAssetId: string,
  destinationScope: string,
  destinationKind: MediaKind,
): Promise<MediaAsset> {
  const source = new MediaStoreClient(namespace, sourceScope)
  const destination = new MediaStoreClient(namespace, destinationScope)
  const response = await source.read(sourceAssetId)
  if (!response.ok || !response.body) throw await MediaStoreError.fromResponse(response)
  const byteSize = Number(response.headers.get('Content-Length'))
  return destination.put(
    response.body,
    destinationKind,
    response.headers.get('Content-Type') ?? 'application/octet-stream',
    byteSize,
  )
}

export function publicMediaResponse(
  response: Response,
  cacheControl: string,
  contentDisposition?: string,
): Response {
  const headers = new Headers()
  for (const name of ['Accept-Ranges', 'Content-Type', 'Content-Length', 'Content-Range']) {
    const value = response.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('Cache-Control', cacheControl)
  headers.set('X-Content-Type-Options', 'nosniff')
  if (contentDisposition) headers.set('Content-Disposition', contentDisposition)
  return new Response(response.body, { status: response.status, headers })
}

export class MediaStoreError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number,
  ) {
    super(reason)
  }

  static async fromResponse(response: Response) {
    let reason = 'storage-failed'
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string') reason = body.error
    } catch {
      // Keep the bounded internal reason.
    }
    return new MediaStoreError(reason, response.status)
  }
}

function parseKind(value: string | null): MediaKind {
  if (!value || !MEDIA_KINDS.includes(value as MediaKind))
    throw new MediaStoreError('invalid-kind', 400)
  return value as MediaKind
}

function parseOptionalLength(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new MediaStoreError('invalid-length', 400)
  return parsed
}

function validateSignature(prefix: Uint8Array, length: number, mimeType: string) {
  const valid =
    mimeType === 'image/jpeg'
      ? length >= 2 && prefix[0] === 0xff && prefix[1] === 0xd8
      : mimeType === 'image/webp'
        ? length >= 12 && ascii(prefix, 0, 4) === 'RIFF' && ascii(prefix, 8, 12) === 'WEBP'
        : mimeType.startsWith('audio/ogg')
          ? length >= 4 && ascii(prefix, 0, 4) === 'OggS'
          : mimeType.startsWith('video/webm') || mimeType.startsWith('audio/webm')
            ? length >= 4 &&
              prefix[0] === 0x1a &&
              prefix[1] === 0x45 &&
              prefix[2] === 0xdf &&
              prefix[3] === 0xa3
            : length >= 8 && ascii(prefix, 4, 8) === 'ftyp'
  if (!valid) throw new MediaStoreError('unsupported-media', 415)
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function parseRange(
  value: string | null,
  byteSize: number,
): { start: number; end: number } | 'invalid' | null {
  if (!value) return null
  if (byteSize <= 0 || value.includes(',')) return 'invalid'
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return 'invalid'
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, byteSize - suffix), end: byteSize - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : byteSize - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= byteSize
  )
    return 'invalid'
  return { start, end: Math.min(requestedEnd, byteSize - 1) }
}

function assetFromHeaders(headers: Headers): MediaAsset {
  return {
    assetId: headers.get('X-Media-Asset-Id')!,
    kind: headers.get('X-Media-Kind') as MediaKind,
    mimeType: headers.get('Content-Type')!,
    byteSize: Number(headers.get('X-Media-Total-Bytes')),
    chunkCount: Number(headers.get('X-Media-Chunk-Count')),
    createdAt: Number(headers.get('X-Media-Created-At')),
  }
}

function mediaError(error: string, status: number) {
  return Response.json({ error }, { status })
}

async function readRetainedAssetIds(request: Request): Promise<string[]> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new MediaStoreError('invalid-retain-list', 400)
  const value = (await request.json()) as { assetIds?: unknown }
  if (
    !Array.isArray(value.assetIds) ||
    value.assetIds.length > 8 ||
    value.assetIds.some((assetId) => typeof assetId !== 'string' || !ASSET_ID.test(assetId))
  )
    throw new MediaStoreError('invalid-retain-list', 400)
  return [...new Set(value.assetIds)] as string[]
}
