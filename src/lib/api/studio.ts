import { apiErrorSchema } from '../../../shared/schemas/protocol'
import {
  preparationDraftResponseSchema,
  sceneListResponseSchema,
} from '../../../shared/schemas/studio'
import type { Scene, SeparationResult } from '../../../shared/types'
import { apiUrl, ApiError } from './rooms'
import { studioAuthorization } from '../studio/token'
import type { VideoMetadata } from '../studio/media'
import type { GeneratedThumbnail } from '../studio/thumbnail'

const headers = () => ({ Authorization: studioAuthorization() })

export async function listPrivateScenes(signal?: AbortSignal) {
  return request('/api/private-scenes', sceneListResponseSchema, { signal })
}

export async function getPrivateScene(sceneId: string, signal?: AbortSignal) {
  return request(
    `/api/private-scenes/${encodeURIComponent(sceneId)}`,
    preparationDraftResponseSchema,
    { signal },
  )
}

export async function uploadPrivateVideo(
  file: File,
  metadata: VideoMetadata,
  signal?: AbortSignal,
) {
  return request('/api/private-scenes/upload', preparationDraftResponseSchema, {
    method: 'POST',
    body: file,
    signal,
    headers: {
      'Content-Type': metadata.mimeType,
      'X-Scene-Filename': encodeURIComponent(metadata.filename),
      'X-Scene-Duration-Ms': String(metadata.durationMs),
      'X-Scene-Width': String(metadata.width),
      'X-Scene-Height': String(metadata.height),
    },
  })
}

export async function savePrivateScene(scene: Scene, signal?: AbortSignal) {
  return request(
    `/api/private-scenes/${encodeURIComponent(scene.id)}`,
    preparationDraftResponseSchema,
    {
      method: 'PUT',
      body: JSON.stringify({ scene }),
      signal,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

export async function deletePrivateScene(sceneId: string, signal?: AbortSignal) {
  const response = await fetch(apiUrl(`/api/private-scenes/${encodeURIComponent(sceneId)}`), {
    method: 'DELETE',
    headers: headers(),
    signal,
  })
  if (!response.ok) throw await apiFailure(response)
}

export async function fetchPrivateSceneSource(sceneId: string, signal?: AbortSignal) {
  return fetchBlob(`/api/private-scenes/${encodeURIComponent(sceneId)}/source`, headers(), signal)
}

export async function fetchPrivateSceneBackground(sceneId: string, signal?: AbortSignal) {
  return fetchBlob(
    `/api/private-scenes/${encodeURIComponent(sceneId)}/background`,
    headers(),
    signal,
  )
}

export async function fetchPrivateSceneThumbnail(sceneId: string, signal?: AbortSignal) {
  return fetchBlob(
    `/api/private-scenes/${encodeURIComponent(sceneId)}/thumbnail`,
    headers(),
    signal,
  )
}

export async function uploadPrivateSceneThumbnail(
  sceneId: string,
  thumbnail: GeneratedThumbnail,
  signal?: AbortSignal,
) {
  return request(
    `/api/private-scenes/${encodeURIComponent(sceneId)}/thumbnail`,
    preparationDraftResponseSchema,
    {
      method: 'POST',
      body: thumbnail.blob,
      signal,
      headers: {
        'Content-Type': thumbnail.mimeType,
        'X-Thumbnail-Width': String(thumbnail.width),
        'X-Thumbnail-Height': String(thumbnail.height),
        'X-Thumbnail-Captured-At-Ms': String(thumbnail.capturedAtMs),
      },
    },
  )
}

export async function uploadPrivateSceneBackground(
  sceneId: string,
  background: Blob,
  metadata: SeparationResult,
  signal?: AbortSignal,
) {
  return request(
    `/api/private-scenes/${encodeURIComponent(sceneId)}/background`,
    preparationDraftResponseSchema,
    {
      method: 'POST',
      body: background,
      signal,
      headers: {
        'Content-Type': metadata.mimeType,
        'X-Background-Duration-Ms': String(metadata.durationMs),
        'X-Background-Sample-Rate': String(metadata.sampleRate),
        'X-Background-Channels': String(metadata.channels),
        'X-Background-Provider': encodeURIComponent(metadata.provider),
        'X-Background-Provider-Version': encodeURIComponent(metadata.providerVersion),
        'X-Background-Model': encodeURIComponent(metadata.model),
        'X-Background-Device': metadata.device,
      },
    },
  )
}

export async function fetchRoomSceneSource(
  session: { code: string; roomId: string; playerId: string; token: string },
  signal?: AbortSignal,
) {
  return fetchBlob(
    `/api/rooms/${session.code}/source-video`,
    {
      Authorization: `Bearer ${session.token}`,
      'X-Room-Id': session.roomId,
      'X-Player-Id': session.playerId,
    },
    signal,
  )
}

async function request<T>(
  path: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  init: RequestInit = {},
) {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
  })
  if (!response.ok) throw await apiFailure(response)
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success)
    throw new ApiError('Sahne servisinden geçersiz bir yanıt geldi.', 'INVALID_RESPONSE')
  return parsed.data
}

async function fetchBlob(
  path: string,
  requestHeaders: Record<string, string>,
  signal?: AbortSignal,
) {
  const response = await fetch(apiUrl(path), { headers: requestHeaders, signal })
  if (!response.ok) throw await apiFailure(response)
  return response.blob()
}

async function apiFailure(response: Response) {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null))
  const messages: Record<string, string> = {
    UNAUTHORIZED: 'Bu özel sahneye erişim iznin yok.',
    INVALID_INPUT: 'Sahne bilgileri geçerli değil.',
    UPLOAD_TOO_LARGE: 'Video en fazla 25 MB olabilir.',
    RATE_LIMITED: 'Çok fazla istek gönderildi. Biraz bekleyip yeniden dene.',
  }
  return new ApiError(
    parsed.success
      ? (messages[parsed.data.code] ?? parsed.data.message)
      : 'Sahne servisine ulaşılamadı.',
    parsed.success ? parsed.data.code : 'SERVER_ERROR',
  )
}
