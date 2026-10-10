import type { DialogueLine } from '../../../shared/types'
import { ALLOWED_RECORDING_MIME_TYPES } from '../../../shared/schemas/recording'

export const RECORDER_MIME_PREFERENCES = ALLOWED_RECORDING_MIME_TYPES

export interface LocalLineRecording {
  recordingId: string
  lineId: string
  playerId: string
  startMs: number
  endMs: number
  captureStartMs: number
  captureEndMs: number
  durationMs: number
  mimeType: string
  blob: Blob
  objectUrl: string
}

export function selectSupportedRecorderMimeType(
  Recorder: typeof MediaRecorder | undefined,
): string | null {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return null
  return RECORDER_MIME_PREFERENCES.find((mimeType) => Recorder.isTypeSupported(mimeType)) ?? null
}

export function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Mikrofon izni verilmedi. Tarayıcı izinlerinden mikrofon erişimini açıp tekrar dene.'
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError')
      return 'Kullanılabilir bir mikrofon bulunamadı. Bir mikrofon bağlayıp tekrar dene.'
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError')
      return 'Mikrofon şu anda kullanılamıyor. Başka bir uygulama kullanıyor olabilir.'
    if (error.name === 'AbortError')
      return 'Mikrofon isteği tamamlanamadı. Cihazını kontrol edip tekrar dene.'
  }
  return 'Mikrofon erişimi kurulamadı. Tarayıcı ve cihaz ayarlarını kontrol edip tekrar dene.'
}

export function isOwnedLine(line: DialogueLine, ownedLineIds: ReadonlySet<string>): boolean {
  return ownedLineIds.has(line.id)
}
