import { DurableObject } from 'cloudflare:workers'
import {
  BACKGROUND_AUDIO_MIME_TYPE,
  backgroundAssetSchema,
  MAX_BACKGROUND_AUDIO_BYTES,
  MAX_PRIVATE_SCENE_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_THUMBNAIL_DIMENSION,
  preparationDraftSchema,
  privateVideoMimeSchema,
  savePreparedSceneSchema,
  studioTokenSchema,
  thumbnailAssetSchema,
  thumbnailMimeSchema,
  uploadedMediaSchema,
} from '../../shared/schemas/studio'
import type { PreparationDraft, ThumbnailAsset } from '../../shared/types'
import { RoomError } from '../domain/errors'
import { errorResponse, json, readJson } from '../lib/http'
import { hashToken } from '../lib/tokens'
import {
  MediaStoreClient,
  MediaStoreError,
  publicMediaResponse,
  type MediaAsset,
  type MediaKind,
} from '../storage/mediaStore'
import type { Env } from '../types/env'

interface StoredDraft extends PreparationDraft {
  ownerHash: string
  sourceAssetId?: string
  backgroundAssetId?: string
  thumbnailAssetId?: string
}

export class SceneStudio extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const ownerHash = await this.authorize(request)
      const url = new URL(request.url)
      if (url.pathname === '/list' && request.method === 'GET') {
        const records = await this.ctx.storage.list<StoredDraft>({ prefix: 'scene:' })
        const scenes = [...records.values()]
          .filter((record) => record.ownerHash === ownerHash && record.status === 'prepared')
          .flatMap((record) => (record.scene ? [record.scene] : []))
          .sort((left, right) => left.title.localeCompare(right.title, 'tr'))
        return json({ scenes })
      }

      if (url.pathname === '/upload' && request.method === 'POST') {
        const filename = decodeHeader(request, 'X-Scene-Filename')
        const mimeType = privateVideoMimeSchema.safeParse(request.headers.get('Content-Type'))
        const durationMs = positiveIntegerHeader(request, 'X-Scene-Duration-Ms')
        const width = positiveIntegerHeader(request, 'X-Scene-Width')
        const height = positiveIntegerHeader(request, 'X-Scene-Height')
        if (!mimeType.success)
          throw new RoomError('INVALID_INPUT', 'Unsupported private scene video type.', 415)
        const sceneId = `private-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
        const provisionalMedia = uploadedMediaSchema.parse({
          sceneId,
          filename,
          mimeType: mimeType.data,
          byteSize: 1,
          durationMs,
          width,
          height,
          uploadedAt: Date.now(),
        })
        const asset = await this.storeUpload(
          request,
          sceneId,
          'scene-source',
          mimeType.data,
          MAX_PRIVATE_SCENE_BYTES,
        )
        const media = uploadedMediaSchema.parse({
          ...provisionalMedia,
          byteSize: asset.byteSize,
        })
        const stored: StoredDraft = {
          ownerHash,
          sourceAssetId: asset.assetId,
          media,
          scene: null,
          status: 'draft',
          warnings: [],
        }
        try {
          await this.ctx.storage.put(`scene:${sceneId}`, stored)
        } catch (error) {
          await this.media(sceneId).delete(asset.assetId)
          throw error
        }
        return json({ draft: publicDraft(stored) }, 201)
      }

      const route =
        /^\/(?:scene|source|background|thumbnail|internal)\/(private-[a-f0-9]{12})$/.exec(
          url.pathname,
        )
      if (!route) throw new RoomError('INVALID_INPUT', 'Scene Studio route not found.', 404)
      const sceneId = route[1]!
      const stored = await this.ctx.storage.get<StoredDraft>(`scene:${sceneId}`)
      if (!stored || stored.ownerHash !== ownerHash)
        throw new RoomError('UNAUTHORIZED', 'This private scene is unavailable.', 404)

      if (url.pathname.startsWith('/source/') && ['GET', 'HEAD'].includes(request.method)) {
        if (!stored.sourceAssetId)
          throw new RoomError('RECORDING_NOT_FOUND', 'Private scene media is missing.', 404)
        return this.serve(stored.media.sceneId, stored.sourceAssetId, request, 'private, no-store')
      }
      if (url.pathname.startsWith('/background/') && ['GET', 'HEAD'].includes(request.method)) {
        if (!stored.backgroundAudio || !stored.backgroundAssetId)
          throw new RoomError(
            'RECORDING_NOT_FOUND',
            'Prepared background audio is unavailable.',
            404,
          )
        return this.serve(sceneId, stored.backgroundAssetId, request, 'private, no-store')
      }
      if (url.pathname.startsWith('/thumbnail/') && ['GET', 'HEAD'].includes(request.method)) {
        if (!stored.thumbnail || !stored.thumbnailAssetId)
          throw new RoomError('RECORDING_NOT_FOUND', 'Scene thumbnail is unavailable.', 404)
        return this.serve(sceneId, stored.thumbnailAssetId, request, 'private, max-age=300')
      }
      if (url.pathname.startsWith('/internal/') && request.method === 'GET')
        return json({
          draft: publicDraft(stored),
          sourceAssetId: stored.sourceAssetId,
          backgroundAssetId: stored.backgroundAssetId,
          thumbnailAssetId: stored.thumbnailAssetId,
        })
      if (request.method === 'GET') return json({ draft: publicDraft(stored) })

      if (url.pathname.startsWith('/background/') && request.method === 'POST') {
        if (request.headers.get('Content-Type') !== BACKGROUND_AUDIO_MIME_TYPE)
          throw new RoomError('INVALID_INPUT', 'Only AAC background audio in M4A is accepted.', 415)
        const durationMs = positiveIntegerHeader(request, 'X-Background-Duration-Ms')
        const sampleRate = positiveIntegerHeader(request, 'X-Background-Sample-Rate')
        const channels = positiveIntegerHeader(request, 'X-Background-Channels')
        if (Math.abs(durationMs - stored.media.durationMs) > 250 || channels !== 2)
          throw new RoomError('INVALID_INPUT', 'Background audio timing or channels are invalid.')
        const id = crypto.randomUUID()
        const backgroundAudio = backgroundAssetSchema.parse({
          id,
          mimeType: BACKGROUND_AUDIO_MIME_TYPE,
          byteSize: 1,
          durationMs,
          sampleRate,
          channels,
          createdAt: Date.now(),
          preparation: {
            provider: decodeShortHeader(request, 'X-Background-Provider', 80),
            providerVersion: decodeShortHeader(request, 'X-Background-Provider-Version', 80),
            model: decodeShortHeader(request, 'X-Background-Model', 120),
            device: request.headers.get('X-Background-Device'),
          },
        })
        const asset = await this.storeUpload(
          request,
          sceneId,
          'scene-background',
          BACKGROUND_AUDIO_MIME_TYPE,
          MAX_BACKGROUND_AUDIO_BYTES,
        )
        const authoritativeBackground = backgroundAssetSchema.parse({
          ...backgroundAudio,
          byteSize: asset.byteSize,
        })
        const nextScene = stored.scene
          ? {
              ...stored.scene,
              backgroundAudioUrl: `/api/private-scenes/${sceneId}/background`,
              origin: { ...stored.scene.origin, version: stored.scene.origin.version + 1 },
            }
          : null
        const next: StoredDraft = {
          ...stored,
          scene: nextScene,
          backgroundAudio: authoritativeBackground,
          backgroundAssetId: asset.assetId,
        }
        try {
          await this.ctx.storage.put(`scene:${sceneId}`, next)
        } catch (error) {
          await this.media(sceneId).delete(asset.assetId)
          throw error
        }
        if (stored.backgroundAssetId)
          await this.media(sceneId)
            .delete(stored.backgroundAssetId)
            .catch(() => undefined)
        return json({ draft: publicDraft(next) }, 201)
      }

      if (url.pathname.startsWith('/thumbnail/') && request.method === 'POST') {
        const mimeType = thumbnailMimeSchema.safeParse(request.headers.get('Content-Type'))
        if (!mimeType.success)
          throw new RoomError('INVALID_INPUT', 'Only WebP or JPEG thumbnails are accepted.', 415)
        const width = positiveIntegerHeader(request, 'X-Thumbnail-Width')
        const height = positiveIntegerHeader(request, 'X-Thumbnail-Height')
        const capturedAtMs = nonnegativeIntegerHeader(request, 'X-Thumbnail-Captured-At-Ms')
        if (
          width > MAX_THUMBNAIL_DIMENSION ||
          height > MAX_THUMBNAIL_DIMENSION ||
          capturedAtMs > stored.media.durationMs
        )
          throw new RoomError('INVALID_INPUT', 'Thumbnail dimensions or timestamp are invalid.')
        const id = crypto.randomUUID()
        const thumbnail = thumbnailAssetSchema.parse({
          id,
          mimeType: mimeType.data,
          byteSize: 1,
          width,
          height,
          capturedAtMs,
          createdAt: Date.now(),
        })
        const asset = await this.storeUpload(
          request,
          sceneId,
          'scene-thumbnail',
          mimeType.data,
          MAX_THUMBNAIL_BYTES,
        )
        const storedThumbnailResponse = await this.media(sceneId).read(asset.assetId)
        const thumbnailBytes = new Uint8Array(await storedThumbnailResponse.arrayBuffer())
        const detected = imageDimensions(thumbnailBytes, mimeType.data)
        if (!detected || detected.width !== width || detected.height !== height) {
          await this.media(sceneId).delete(asset.assetId)
          throw new RoomError(
            'INVALID_INPUT',
            'Thumbnail bytes do not match the declared type or dimensions.',
          )
        }
        const authoritativeThumbnail = thumbnailAssetSchema.parse({
          ...thumbnail,
          byteSize: asset.byteSize,
        })
        const next: StoredDraft = {
          ...stored,
          scene: stored.scene
            ? { ...stored.scene, thumbnailUrl: `/api/private-scenes/${sceneId}/thumbnail` }
            : null,
          thumbnail: authoritativeThumbnail,
          thumbnailAssetId: asset.assetId,
        }
        try {
          await this.ctx.storage.put(`scene:${sceneId}`, next)
        } catch (error) {
          await this.media(sceneId).delete(asset.assetId)
          throw error
        }
        if (stored.thumbnailAssetId)
          await this.media(sceneId)
            .delete(stored.thumbnailAssetId)
            .catch(() => undefined)
        return json({ draft: publicDraft(next) }, 201)
      }

      if (request.method === 'PUT') {
        const parsed = savePreparedSceneSchema.safeParse(await readJson(request))
        if (!parsed.success)
          throw new RoomError(
            'INVALID_INPUT',
            parsed.error.issues[0]?.message ?? 'Invalid private scene.',
          )
        const scene = parsed.data.scene
        if (
          scene.id !== sceneId ||
          scene.origin.kind !== 'private' ||
          scene.origin.sourceFileName !== stored.media.filename ||
          Math.abs(scene.durationMs - stored.media.durationMs) > 250
        )
          throw new RoomError('INVALID_INPUT', 'Scene metadata does not match its uploaded media.')
        const sceneWithoutBackground = { ...scene }
        delete sceneWithoutBackground.backgroundAudioUrl
        delete sceneWithoutBackground.thumbnailUrl
        const next = preparationDraftSchema.parse({
          media: stored.media,
          scene: {
            ...sceneWithoutBackground,
            ...(stored.backgroundAudio
              ? { backgroundAudioUrl: `/api/private-scenes/${sceneId}/background` }
              : {}),
            ...(stored.thumbnail
              ? { thumbnailUrl: `/api/private-scenes/${sceneId}/thumbnail` }
              : {}),
            origin: { ...scene.origin, version: (stored.scene?.origin.version ?? 0) + 1 },
          },
          backgroundAudio: stored.backgroundAudio,
          thumbnail: stored.thumbnail,
          status: 'prepared',
          warnings: [],
        })
        await this.ctx.storage.put(`scene:${sceneId}`, {
          ...next,
          ownerHash,
          sourceAssetId: stored.sourceAssetId,
          backgroundAssetId: stored.backgroundAssetId,
          thumbnailAssetId: stored.thumbnailAssetId,
        })
        return json({ draft: next })
      }

      if (request.method === 'DELETE') {
        await this.ctx.storage.delete(`scene:${sceneId}`)
        await this.media(sceneId).cleanup()
        return new Response(null, { status: 204 })
      }
      throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
    } catch (error) {
      return errorResponse(error)
    }
  }

  private async authorize(request: Request) {
    const authorization = request.headers.get('Authorization') ?? ''
    const token = studioTokenSchema.safeParse(authorization.replace(/^Bearer\s+/i, ''))
    if (!token.success)
      throw new RoomError('UNAUTHORIZED', 'A private Scene Studio key is required.', 401)
    return hashToken(token.data)
  }

  private media(sceneId: string) {
    return new MediaStoreClient(this.env.MEDIA_STORE, `scene:${sceneId}`)
  }

  private async storeUpload(
    request: Request,
    sceneId: string,
    kind: MediaKind,
    mimeType: string,
    maximumBytes: number,
  ): Promise<MediaAsset> {
    const declaredHeader = request.headers.get('Content-Length')
    const declared = declaredHeader === null ? undefined : Number(declaredHeader)
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0))
      throw new RoomError('INVALID_INPUT', 'The upload length is invalid.')
    if (declared !== undefined && declared > maximumBytes)
      throw new RoomError('UPLOAD_TOO_LARGE', 'The upload exceeds the upload limit.', 413)
    if (!request.body) throw new RoomError('INVALID_INPUT', 'An upload body is required.')
    try {
      return await this.media(sceneId).put(request.body, kind, mimeType, declared)
    } catch (error) {
      if (error instanceof MediaStoreError) {
        if (error.reason === 'too-large')
          throw new RoomError('UPLOAD_TOO_LARGE', 'The upload exceeds the upload limit.', 413)
        if (error.reason === 'unsupported-media')
          throw new RoomError('INVALID_INPUT', 'The uploaded bytes do not match the media type.')
        if (error.reason === 'empty')
          throw new RoomError('INVALID_INPUT', 'The upload body is empty.')
      }
      throw error
    }
  }

  private async serve(sceneId: string, assetId: string, request: Request, cacheControl: string) {
    const response = await this.media(sceneId).read(
      assetId,
      request.method as 'GET' | 'HEAD',
      request.headers.get('Range'),
    )
    if (response.status === 404)
      throw new RoomError('RECORDING_NOT_FOUND', 'Private scene media is missing.', 404)
    return publicMediaResponse(response, cacheControl)
  }
}

function publicDraft(stored: StoredDraft): PreparationDraft {
  return preparationDraftSchema.parse({
    media: stored.media,
    scene: stored.scene,
    backgroundAudio: stored.backgroundAudio,
    thumbnail: stored.thumbnail,
    status: stored.status,
    warnings: stored.warnings,
  })
}

function decodeShortHeader(request: Request, name: string, maxLength: number) {
  const value = decodeHeader(request, name)
  if (value.length > maxLength)
    throw new RoomError('INVALID_INPUT', 'Background metadata is invalid.')
  return value
}

function positiveIntegerHeader(request: Request, name: string) {
  const value = Number(request.headers.get(name))
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RoomError('INVALID_INPUT', 'Video metadata is invalid.')
  return value
}

function nonnegativeIntegerHeader(request: Request, name: string) {
  const value = Number(request.headers.get(name))
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RoomError('INVALID_INPUT', 'Thumbnail metadata is invalid.')
  return value
}

export function imageDimensions(
  bytes: Uint8Array,
  mimeType: ThumbnailAsset['mimeType'],
): { width: number; height: number } | null {
  return mimeType === 'image/webp' ? webpDimensions(bytes) : jpegDimensions(bytes)
}

function webpDimensions(bytes: Uint8Array) {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP')
    return null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4)
    const length = readUint32Le(bytes, offset + 4)
    const data = offset + 8
    if (data + length > bytes.length) return null
    if (type === 'VP8X' && length >= 10)
      return {
        width: 1 + readUint24Le(bytes, data + 4),
        height: 1 + readUint24Le(bytes, data + 7),
      }
    if (
      type === 'VP8 ' &&
      length >= 10 &&
      bytes[data + 3] === 0x9d &&
      bytes[data + 4] === 0x01 &&
      bytes[data + 5] === 0x2a
    )
      return {
        width: ((bytes[data + 7]! << 8) | bytes[data + 6]!) & 0x3fff,
        height: ((bytes[data + 9]! << 8) | bytes[data + 8]!) & 0x3fff,
      }
    if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f)
      return {
        width: 1 + bytes[data + 1]! + ((bytes[data + 2]! & 0x3f) << 8),
        height:
          1 + (bytes[data + 2]! >> 6) + (bytes[data + 3]! << 2) + ((bytes[data + 4]! & 0x0f) << 10),
      }
    offset = data + length + (length % 2)
  }
  return null
}

function jpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    offset += 2
    if (marker === 0xd9 || marker === 0xda) return null
    if (marker >= 0xd0 && marker <= 0xd7) continue
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (length < 2 || offset + length > bytes.length) return null
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    )
      return {
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
      }
    offset += length
  }
  return null
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end))
}

function readUint24Le(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function decodeHeader(request: Request, name: string) {
  const encoded = request.headers.get(name)
  if (!encoded) throw new RoomError('INVALID_INPUT', 'Video filename is missing.')
  try {
    const value = decodeURIComponent(encoded).trim()
    if (!value || value.length > 255) throw new Error('invalid')
    return value
  } catch {
    throw new RoomError('INVALID_INPUT', 'Video filename is invalid.')
  }
}

export function hasExpectedSignature(bytes: Uint8Array, mimeType: 'video/webm' | 'video/mp4') {
  if (mimeType === 'video/webm')
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    )
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp'
}

export function hasMp4Signature(bytes: Uint8Array) {
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp'
}
