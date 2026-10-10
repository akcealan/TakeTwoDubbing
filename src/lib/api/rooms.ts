import { z } from 'zod'
import { roomErrorMessages } from '../rooms/errorMessages'
import { apiErrorSchema } from '../../../shared/schemas/protocol'
import {
  createRoomSchema,
  joinRoomRequestSchema,
  roomSummarySchema,
  sessionSchema,
} from '../../../shared/schemas/room'
import { recordingUploadResponseSchema } from '../../../shared/schemas/recording'
import {
  FINAL_RESULT_MIME_TYPE,
  MAX_FINAL_RESULT_BYTES,
  resultUploadResponseSchema,
} from '../../../shared/schemas/result'
import type { RoomSession } from '../../../shared/schemas/protocol'
import type { RecordingManifest, StoredRecording } from '../../../shared/types'
import type { LocalLineRecording } from '../recording/localRecording'
import { studioAuthorization } from '../studio/token'

export function apiUrl(path: string): URL {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined
  const base = configured || window.location.origin
  const url = new URL(path, base)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Oda servisi adresi HTTP veya HTTPS kullanmalı.')
  return url
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
  }
}

async function post<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  try {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(data)
      throw new ApiError(
        parsed.success
          ? roomErrorMessages[parsed.data.code]
          : 'Oda servisi şu anda kullanılamıyor. Lütfen tekrar dene.',
        parsed.success ? parsed.data.code : 'SERVER_ERROR',
      )
    }
    const parsed = schema.safeParse(data)
    if (!parsed.success)
      throw new ApiError(
        'Oda servisinden geçersiz bir yanıt geldi. Lütfen tekrar dene.',
        'INVALID_RESPONSE',
      )
    return parsed.data
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw error
    console.error('Room request failed', error instanceof Error ? error.name : 'Unknown error')
    throw new ApiError(
      'Oda servisine ulaşılamadı. Bağlantını kontrol edip tekrar dene.',
      'NETWORK_ERROR',
    )
  }
}

async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  try {
    const response = await fetch(apiUrl(path), {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
        : AbortSignal.timeout(5_000),
    })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(data)
      throw new ApiError(
        parsed.success
          ? roomErrorMessages[parsed.data.code]
          : 'Oda servisi şu anda kullanılamıyor. Lütfen tekrar dene.',
        parsed.success ? parsed.data.code : 'SERVER_ERROR',
      )
    }
    const parsed = schema.safeParse(data)
    if (!parsed.success)
      throw new ApiError(
        'Oda servisinden geçersiz bir yanıt geldi. Lütfen tekrar dene.',
        'INVALID_RESPONSE',
      )
    return parsed.data
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw error
    throw new ApiError(
      'Oda servisine ulaşılamadı. Bağlantını kontrol edip tekrar dene.',
      'NETWORK_ERROR',
    )
  }
}

export type JoinRoomRequest = z.infer<typeof joinRoomRequestSchema>

export function createJoinRoomRequest(nickname: string): JoinRoomRequest {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return joinRoomRequestSchema.parse({
    nickname,
    requestId: crypto.randomUUID(),
    requestToken: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  })
}

export function createRoom(sceneId: string, nickname: string, signal?: AbortSignal) {
  return post('/api/rooms', createRoomSchema.parse({ sceneId, nickname }), sessionSchema, signal, {
    'X-Scene-Authorization': studioAuthorization(),
  })
}
export function joinRoom(code: string, request: JoinRoomRequest, signal?: AbortSignal) {
  return post(
    `/api/rooms/${encodeURIComponent(code)}/join`,
    joinRoomRequestSchema.parse(request),
    sessionSchema,
    signal,
  )
}

export function getRoomSummary(code: string, signal?: AbortSignal) {
  return get(`/api/rooms/${encodeURIComponent(code)}`, roomSummarySchema, signal)
}

export async function uploadLineRecording(
  session: RoomSession,
  recording: LocalLineRecording,
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(
      apiUrl(
        `/api/rooms/${encodeURIComponent(session.code)}/recordings/${encodeURIComponent(recording.lineId)}`,
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': recording.mimeType,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'X-Recording-Id': recording.recordingId,
          'X-Recording-Duration-Ms': String(recording.durationMs),
          'X-Capture-Start-Ms': String(recording.captureStartMs),
          'X-Capture-End-Ms': String(recording.captureEndMs),
        },
        body: recording.blob,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
    )
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(data)
      throw new ApiError(
        parsed.success
          ? roomErrorMessages[parsed.data.code]
          : 'Ses kaydı geçici depoya kaydedilemedi. Yerel kayıt duruyor; tekrar dene.',
        parsed.success ? parsed.data.code : 'UPLOAD_FAILED',
      )
    }
    const parsed = recordingUploadResponseSchema.safeParse(data)
    if (!parsed.success)
      throw new ApiError(
        'Kayıt servisinden geçersiz bir yanıt geldi. Yerel kayıt duruyor; tekrar dene.',
        'INVALID_RESPONSE',
      )
    return parsed.data.recording
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw error
    throw new ApiError(
      'Kayıt servisine ulaşılamadı. Yerel kayıt duruyor; bağlantını kontrol edip tekrar dene.',
      'NETWORK_ERROR',
    )
  }
}

export async function fetchFrozenRecording(
  session: RoomSession,
  manifest: RecordingManifest,
  recording: Pick<StoredRecording, 'recordingId' | 'mimeType' | 'byteSize'>,
  signal?: AbortSignal,
): Promise<Blob> {
  try {
    const response = await fetch(
      apiUrl(
        `/api/rooms/${encodeURIComponent(session.code)}/render-inputs/${encodeURIComponent(recording.recordingId)}`,
      ),
      {
        headers: {
          Authorization: `Bearer ${session.token}`,
          'X-Room-Id': session.roomId,
          'X-Player-Id': session.playerId,
          'X-Manifest-Id': manifest.manifestId,
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
    )
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null)
      const parsed = apiErrorSchema.safeParse(data)
      throw new ApiError(
        parsed.success
          ? roomErrorMessages[parsed.data.code]
          : 'Dondurulmuş listedeki ses kaydı alınamadı. Bağlantını kontrol edip tekrar dene.',
        parsed.success ? parsed.data.code : 'RECORDING_NOT_FOUND',
      )
    }
    const blob = await response.blob()
    if (blob.size !== recording.byteSize)
      throw new ApiError(
        'Dondurulmuş listedeki ses kaydı eksik geldi. Bir süre sonra tekrar dene.',
        'RECORDING_NOT_FOUND',
      )
    return blob.type === recording.mimeType ? blob : blob.slice(0, blob.size, recording.mimeType)
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw error
    throw new ApiError(
      'Dondurulmuş ses kayıtlarına ulaşılamadı. Bağlantını kontrol edip tekrar dene.',
      'NETWORK_ERROR',
    )
  }
}

function resultHeaders(session: RoomSession, manifestId: string) {
  return {
    Authorization: `Bearer ${session.token}`,
    'X-Room-Id': session.roomId,
    'X-Player-Id': session.playerId,
    'X-Manifest-Id': manifestId,
  }
}

export async function uploadFinalResult(
  session: RoomSession,
  manifest: RecordingManifest,
  resultId: string,
  blob: Blob,
  signal?: AbortSignal,
) {
  if (blob.size > MAX_FINAL_RESULT_BYTES)
    throw new ApiError(
      'Final video 64 MiB yükleme sınırını aşıyor. Yerel video korunuyor; daha kısa veya daha düşük çözünürlüklü bir sahneyle tekrar dene.',
      'UPLOAD_TOO_LARGE',
    )
  try {
    const response = await fetch(
      apiUrl(
        `/api/rooms/${encodeURIComponent(session.code)}/results/${encodeURIComponent(resultId)}`,
      ),
      {
        method: 'POST',
        headers: {
          ...resultHeaders(session, manifest.manifestId),
          'X-Result-Id': resultId,
          'Content-Type': FINAL_RESULT_MIME_TYPE,
        },
        body: blob,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      },
    )
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(data)
      throw new ApiError(
        parsed.success
          ? parsed.data.code === 'UPLOAD_TOO_LARGE'
            ? 'Final video 64 MiB yükleme sınırını aşıyor. Yerel video korunuyor; daha kısa veya daha düşük çözünürlüklü bir sahneyle tekrar dene.'
            : roomErrorMessages[parsed.data.code]
          : 'Final video yüklenemedi. Yerel video korunuyor; tekrar dene.',
        parsed.success ? parsed.data.code : 'UPLOAD_FAILED',
      )
    }
    const parsed = resultUploadResponseSchema.safeParse(data)
    if (!parsed.success)
      throw new ApiError(
        'Sonuç servisinden geçersiz bir yanıt geldi. Tekrar dene.',
        'INVALID_RESPONSE',
      )
    return parsed.data.result
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw error
    throw new ApiError(
      'Final video yüklenemedi. Yerel video korunuyor; bağlantını kontrol edip tekrar dene.',
      'NETWORK_ERROR',
    )
  }
}

export async function fetchSharedResult(
  session: RoomSession,
  result: { resultId: string; manifestId: string; byteSize: number },
  signal?: AbortSignal,
): Promise<Blob> {
  try {
    const response = await fetch(
      apiUrl(
        `/api/rooms/${encodeURIComponent(session.code)}/results/${encodeURIComponent(result.resultId)}`,
      ),
      {
        headers: resultHeaders(session, result.manifestId),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      },
    )
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null)
      const parsed = apiErrorSchema.safeParse(data)
      throw new ApiError(
        parsed.success ? roomErrorMessages[parsed.data.code] : 'Paylaşılan video alınamadı.',
        parsed.success ? parsed.data.code : 'RESULT_NOT_FOUND',
      )
    }
    const blob = await response.blob()
    if (blob.size !== result.byteSize)
      throw new ApiError('Paylaşılan video eksik geldi. Tekrar dene.', 'RESULT_NOT_FOUND')
    return blob.type === FINAL_RESULT_MIME_TYPE
      ? blob
      : blob.slice(0, blob.size, FINAL_RESULT_MIME_TYPE)
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw error
    throw new ApiError(
      'Paylaşılan videoya ulaşılamadı. Bağlantını kontrol edip tekrar dene.',
      'NETWORK_ERROR',
    )
  }
}
