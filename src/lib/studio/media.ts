import {
  ALLOWED_PRIVATE_VIDEO_TYPES,
  MAX_PRIVATE_SCENE_BYTES,
  MAX_PRIVATE_SCENE_DURATION_MS,
} from '../../../shared/schemas/studio'

export interface VideoMetadata {
  filename: string
  mimeType: 'video/webm' | 'video/mp4'
  byteSize: number
  durationMs: number
  width: number
  height: number
}

export async function inspectVideoFile(file: File): Promise<VideoMetadata> {
  if (!file.size) throw new Error('Boş bir dosya yüklenemez.')
  if (file.size > MAX_PRIVATE_SCENE_BYTES) throw new Error('Video en fazla 25 MB olabilir.')
  if (
    !ALLOWED_PRIVATE_VIDEO_TYPES.includes(file.type as (typeof ALLOWED_PRIVATE_VIDEO_TYPES)[number])
  )
    throw new Error('Bu aşamada yalnızca WebM ve MP4 videolar destekleniyor.')
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  if (!matchesVideoSignature(bytes, file.type))
    throw new Error('Dosyanın içeriği bildirilen video türüyle eşleşmiyor.')
  const objectUrl = URL.createObjectURL(file)
  try {
    const detected = await readVideoElementMetadata(objectUrl)
    if (!detected.width || !detected.height)
      throw new Error('Dosyada okunabilir bir video görüntüsü bulunamadı.')
    const durationMs = Math.round(detected.duration * 1000)
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new Error('Videonun süresi okunamadı.')
    if (durationMs > MAX_PRIVATE_SCENE_DURATION_MS)
      throw new Error('Video bu aşamada en fazla 10 dakika olabilir.')
    return {
      filename: file.name,
      mimeType: file.type as VideoMetadata['mimeType'],
      byteSize: file.size,
      durationMs,
      width: detected.width,
      height: detected.height,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function matchesVideoSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === 'video/webm')
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    )
  if (mimeType === 'video/mp4')
    return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp'
  return false
}

function readVideoElementMetadata(url: string) {
  return new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    let timer = 0
    const finish = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return false
      window.clearTimeout(timer)
      resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight })
      return true
    }
    video.onloadedmetadata = () => {
      if (finish()) return
      // Some valid WebM files in the current stack omit container duration. Seeking
      // past EOF asks the browser demuxer to discover the real duration locally.
      video.ondurationchange = () => finish()
      video.onseeked = () => finish()
      timer = window.setTimeout(() => reject(new Error('Videonun süresi okunamadı.')), 5000)
      video.currentTime = 24 * 60 * 60
    }
    video.onerror = () => reject(new Error('Video tarayıcı tarafından okunamadı.'))
    video.src = url
  })
}

export function captureVideoTimeMs(currentTime: number, durationMs: number) {
  return Math.max(0, Math.min(durationMs, Math.round(currentTime * 1000)))
}
