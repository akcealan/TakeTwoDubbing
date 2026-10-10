import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ffmpegRuntimeManifest } from '../../../shared/runtime/ffmpegRuntime'
import { reconstructFfmpegWasm } from './ffmpegRuntime'

const staticLimitBytes = 25 * 1024 * 1024

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function runtimeFetch(overrides: Record<string, Uint8Array | null> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    const fileName = path.slice(path.lastIndexOf('/') + 1)
    if (Object.hasOwn(overrides, fileName)) {
      const value = overrides[fileName]
      return value ? new Response(value as BodyInit) : new Response('missing', { status: 404 })
    }
    const bytes = await readFile(resolve(`public${ffmpegRuntimeManifest.basePath}`, fileName))
    return new Response(bytes as BodyInit)
  })
}

describe('static multipart ffmpeg runtime', () => {
  it('uses deterministic sub-25-MiB parts that reconstruct the canonical WASM', async () => {
    expect(ffmpegRuntimeManifest.wasmParts.map((part) => part.fileName)).toEqual([
      'ffmpeg-core.wasm.part-000',
      'ffmpeg-core.wasm.part-001',
    ])
    const parts = await Promise.all(
      ffmpegRuntimeManifest.wasmParts.map(async (part) => {
        const bytes = await readFile(
          resolve(`public${ffmpegRuntimeManifest.basePath}`, part.fileName),
        )
        expect(bytes.byteLength).toBe(part.byteSize)
        expect(bytes.byteLength).toBeLessThan(staticLimitBytes)
        expect(hash(bytes)).toBe(part.sha256)
        return bytes
      }),
    )
    const reconstructed = Buffer.concat(parts)
    expect(reconstructed.byteLength).toBe(ffmpegRuntimeManifest.originalWasm.byteSize)
    expect(hash(reconstructed)).toBe(ffmpegRuntimeManifest.originalWasm.sha256)
  })

  it('reconstructs successfully through the browser loader', async () => {
    const bytes = await reconstructFfmpegWasm(new AbortController().signal, runtimeFetch())
    expect(bytes.byteLength).toBe(ffmpegRuntimeManifest.originalWasm.byteSize)
    expect(hash(bytes)).toBe(ffmpegRuntimeManifest.originalWasm.sha256)
  })

  it('fails closed when a part is missing', async () => {
    await expect(
      reconstructFfmpegWasm(
        new AbortController().signal,
        runtimeFetch({ 'ffmpeg-core.wasm.part-001': null }),
      ),
    ).rejects.toThrow('HTTP 404')
  })

  it('fails closed when a part is corrupt', async () => {
    const corrupt = new Uint8Array(ffmpegRuntimeManifest.wasmParts[0]!.byteSize)
    await expect(
      reconstructFfmpegWasm(
        new AbortController().signal,
        runtimeFetch({ 'ffmpeg-core.wasm.part-000': corrupt }),
      ),
    ).rejects.toThrow('integrity mismatch')
  })
})
