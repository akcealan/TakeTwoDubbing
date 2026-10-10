import {
  aiHealthSchema,
  aiJobEnvelopeSchema,
  separationHealthSchema,
  separationJobEnvelopeSchema,
} from '../../../shared/schemas/ai'
import type { UploadedMedia } from '../../../shared/types'

const companionBaseUrl = (import.meta.env.VITE_AI_COMPANION_URL || 'http://127.0.0.1:8765').replace(
  /\/$/,
  '',
)

export class LocalAiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'unavailable'
      | 'permission-denied'
      | 'origin-denied'
      | 'setup'
      | 'invalid-response'
      | 'job-failed',
  ) {
    super(message)
  }
}

export async function getLocalAiHealth(signal?: AbortSignal) {
  const response = await localFetch('/v1/health', { signal })
  const parsed = aiHealthSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success)
    throw new LocalAiError('Yerel AI servisi geçersiz bir durum yanıtı verdi.', 'invalid-response')
  if (parsed.data.status === 'setup_required')
    throw new LocalAiError(parsed.data.issues.map((issue) => issue.message).join(' '), 'setup')
  return parsed.data
}

export async function createLocalAiJob(
  source: Blob,
  media: UploadedMedia,
  expectedSpeakerCount: number | null,
  signal?: AbortSignal,
) {
  const body = new FormData()
  body.append('media', source, media.filename)
  body.append('durationMs', String(media.durationMs))
  if (expectedSpeakerCount !== null)
    body.append('expectedSpeakerCount', String(expectedSpeakerCount))
  const response = await localFetch('/v1/jobs', { method: 'POST', body, signal })
  return parseJob(response)
}

export async function getLocalAiJob(jobId: string, signal?: AbortSignal) {
  return parseJob(await localFetch(`/v1/jobs/${encodeURIComponent(jobId)}`, { signal }))
}

export async function cancelLocalAiJob(jobId: string) {
  return parseJob(await localFetch(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }))
}

export async function getLocalSeparationHealth(signal?: AbortSignal) {
  const response = await localFetch('/v1/separation/health', { signal })
  const parsed = separationHealthSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success)
    throw new LocalAiError(
      'Yerel AI servisi geçersiz bir ayırma durum yanıtı verdi.',
      'invalid-response',
    )
  return parsed.data
}

export async function createLocalSeparationJob(
  source: Blob,
  media: UploadedMedia,
  requestedDevice: 'auto' | 'cpu' | 'cuda' = 'auto',
  signal?: AbortSignal,
) {
  const body = new FormData()
  body.append('media', source, media.filename)
  body.append('durationMs', String(media.durationMs))
  body.append('requestedDevice', requestedDevice)
  return parseSeparationJob(
    await localFetch('/v1/separation/jobs', { method: 'POST', body, signal }),
  )
}

export async function getLocalSeparationJob(jobId: string, signal?: AbortSignal) {
  return parseSeparationJob(
    await localFetch(`/v1/separation/jobs/${encodeURIComponent(jobId)}`, { signal }),
  )
}

export async function fetchLocalSeparationBackground(jobId: string, signal?: AbortSignal) {
  const response = await localFetch(`/v1/separation/jobs/${encodeURIComponent(jobId)}/background`, {
    signal,
  })
  const blob = await response.blob()
  if (!blob.size) throw new LocalAiError('Yerel ayırma sonucu boş geldi.', 'invalid-response')
  return blob
}

export async function cancelLocalSeparationJob(jobId: string) {
  return parseSeparationJob(
    await localFetch(`/v1/separation/jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    }),
  )
}

async function localFetch(path: string, init: RequestInit) {
  let response: Response
  try {
    if (await localNetworkPermissionDenied()) throw permissionDeniedError()
    const requestInit: RequestInit & { targetAddressSpace?: 'loopback' } = {
      ...init,
      mode: 'cors',
      headers: { ...Object.fromEntries(new Headers(init.headers)), 'X-Take-Two-Companion': '1' },
      targetAddressSpace: 'loopback',
    }
    response = await fetch(`${companionBaseUrl}${path}`, requestInit)
  } catch (error) {
    if (init.signal?.aborted) throw error
    if (error instanceof LocalAiError) throw error
    if (
      (await localNetworkPermissionDenied()) ||
      (error instanceof Error && /local network|address space|permission/i.test(error.message))
    )
      throw permissionDeniedError()
    throw new LocalAiError(
      'Yerel AI servisi bu bilgisayarda çalışmıyor. Proje kökünde “npm run ai:dev” komutunu çalıştır; elle hazırlama kullanıma devam eder.',
      'unavailable',
    )
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null
    if (response.status === 403)
      throw new LocalAiError(
        "Bu site adresi yerel AI izin listesinde değil. Yerel AI'ı bu üretim adresine izin verecek şekilde yeniden başlat.",
        'origin-denied',
      )
    throw new LocalAiError(
      typeof body?.detail === 'string' ? body.detail : 'Yerel AI isteği tamamlanamadı.',
      'job-failed',
    )
  }
  return response
}

function permissionDeniedError() {
  return new LocalAiError(
    "Tarayıcı bu sitenin yerel AI'a erişmesine izin vermedi. Adres çubuğundaki site izinlerinden yerel ağ erişimine izin verip tekrar dene; tarayıcı güvenliğini kapatma.",
    'permission-denied',
  )
}

async function localNetworkPermissionDenied(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return false
  for (const name of ['loopback-network', 'local-network']) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName })
      if (status.state === 'denied') return true
      if (status.state === 'granted' || status.state === 'prompt') return false
    } catch {
      // Firefox, Safari and older Chromium do not expose these permission names.
    }
  }
  return false
}

async function parseJob(response: Response) {
  const parsed = aiJobEnvelopeSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success)
    throw new LocalAiError('Yerel AI servisi geçersiz bir iş yanıtı verdi.', 'invalid-response')
  return parsed.data.job
}

async function parseSeparationJob(response: Response) {
  const parsed = separationJobEnvelopeSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success)
    throw new LocalAiError(
      'Yerel AI servisi geçersiz bir ayırma işi yanıtı verdi.',
      'invalid-response',
    )
  return parsed.data.job
}
