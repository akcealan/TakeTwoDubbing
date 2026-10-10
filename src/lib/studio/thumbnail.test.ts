import { describe, expect, it, vi } from 'vitest'
import { encodeThumbnailCanvas, representativeFrameTimeMs, thumbnailDimensions } from './thumbnail'

describe('private scene thumbnail helpers', () => {
  it('chooses a deterministic frame away from the first frame and clip end', () => {
    expect(representativeFrameTimeMs(30_000)).toBe(4_500)
    expect(representativeFrameTimeMs(5_000)).toBe(1_000)
    expect(representativeFrameTimeMs(80)).toBe(40)
    expect(representativeFrameTimeMs(0)).toBe(0)
  })

  it('preserves aspect ratio without upscaling and bounds either orientation', () => {
    expect(thumbnailDimensions(1_920, 1_080)).toEqual({ width: 640, height: 360 })
    expect(thumbnailDimensions(360, 640)).toEqual({ width: 360, height: 640 })
    expect(thumbnailDimensions(320, 180)).toEqual({ width: 320, height: 180 })
  })

  it('prefers WebP and falls back to JPEG when WebP encoding is unavailable', async () => {
    const webp = new Blob(['webp'], { type: 'image/webp' })
    const webpCanvas = {
      toBlob: vi.fn((callback: BlobCallback) => callback(webp)),
    } as unknown as HTMLCanvasElement
    await expect(encodeThumbnailCanvas(webpCanvas)).resolves.toBe(webp)
    expect(webpCanvas.toBlob).toHaveBeenCalledOnce()

    const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' })
    const jpegCanvas = {
      toBlob: vi
        .fn()
        .mockImplementationOnce((callback: BlobCallback) => callback(null))
        .mockImplementationOnce((callback: BlobCallback) => callback(jpeg)),
    } as unknown as HTMLCanvasElement
    await expect(encodeThumbnailCanvas(jpegCanvas)).resolves.toBe(jpeg)
    expect(jpegCanvas.toBlob).toHaveBeenNthCalledWith(1, expect.any(Function), 'image/webp', 0.8)
    expect(jpegCanvas.toBlob).toHaveBeenNthCalledWith(2, expect.any(Function), 'image/jpeg', 0.82)
  })
})
