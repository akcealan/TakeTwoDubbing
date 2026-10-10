import { MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_DIMENSION } from '../../../shared/schemas/studio'

export interface GeneratedThumbnail {
  blob: Blob
  mimeType: 'image/webp' | 'image/jpeg'
  width: number
  height: number
  capturedAtMs: number
}

export function representativeFrameTimeMs(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  const endGuardMs = Math.min(100, durationMs / 2)
  return Math.max(
    0,
    Math.round(Math.min(Math.max(1_000, durationMs * 0.15), durationMs - endGuardMs)),
  )
}

export function thumbnailDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('Küçük resim için video boyutları okunamadı.')
  const scale = Math.min(1, MAX_THUMBNAIL_DIMENSION / width, MAX_THUMBNAIL_DIMENSION / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export async function generateVideoThumbnail(
  source: Blob,
  metadata: { durationMs: number; width: number; height: number },
): Promise<GeneratedThumbnail> {
  const capturedAtMs = representativeFrameTimeMs(metadata.durationMs)
  const dimensions = thumbnailDimensions(metadata.width, metadata.height)
  const sourceUrl = URL.createObjectURL(source)
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  try {
    await loadFrame(video, sourceUrl, capturedAtMs)
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Tarayıcı küçük resim tuvalini hazırlayamadı.')
    context.drawImage(video, 0, 0, dimensions.width, dimensions.height)
    const encoded = await encodeThumbnailCanvas(canvas)
    if (encoded.size > MAX_THUMBNAIL_BYTES)
      throw new Error('Oluşturulan küçük resim beklenenden büyük.')
    return {
      blob: encoded,
      mimeType: encoded.type as GeneratedThumbnail['mimeType'],
      ...dimensions,
      capturedAtMs,
    }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(sourceUrl)
  }
}

export async function encodeThumbnailCanvas(canvas: HTMLCanvasElement) {
  const webp = await canvasBlob(canvas, 'image/webp', 0.8)
  if (webp?.type === 'image/webp') return webp
  const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.82)
  if (jpeg?.type === 'image/jpeg') return jpeg
  throw new Error('Tarayıcı WebP veya JPEG küçük resim üretemedi.')
}

function loadFrame(video: HTMLVideoElement, url: string, capturedAtMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('Küçük resim karesi zamanında okunamadı.')),
      8_000,
    )
    const fail = () => {
      window.clearTimeout(timeout)
      reject(new Error('Video karesi küçük resim için okunamadı.'))
    }
    video.onerror = fail
    video.onloadedmetadata = () => {
      video.onseeked = () => {
        window.clearTimeout(timeout)
        resolve()
      }
      video.currentTime = Math.min(capturedAtMs / 1000, Math.max(0, video.duration - 0.05))
    }
    video.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality))
}
