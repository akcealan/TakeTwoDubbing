import { ffmpegRuntimeManifest } from '../../../shared/runtime/ffmpegRuntime'

type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)))
}

async function fetchPart(
  path: string,
  expectedBytes: number,
  expectedHash: string,
  signal: AbortSignal,
  fetchRuntime: RuntimeFetch,
): Promise<ArrayBuffer> {
  let response: Response
  try {
    response = await fetchRuntime(path, { signal, cache: 'force-cache' })
  } catch {
    throw new Error(`Runtime part could not be fetched: ${path}`)
  }
  if (!response.ok) throw new Error(`Runtime part returned HTTP ${response.status}: ${path}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength !== expectedBytes) throw new Error(`Runtime part size mismatch: ${path}`)
  if ((await sha256(buffer)) !== expectedHash)
    throw new Error(`Runtime part integrity mismatch: ${path}`)
  return buffer
}

export async function reconstructFfmpegWasm(
  signal: AbortSignal,
  fetchRuntime: RuntimeFetch = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Uint8Array(ffmpegRuntimeManifest.originalWasm.byteSize)
  let offset = 0
  for (const part of ffmpegRuntimeManifest.wasmParts) {
    const path = `${ffmpegRuntimeManifest.basePath}/${part.fileName}`
    const buffer = await fetchPart(path, part.byteSize, part.sha256, signal, fetchRuntime)
    output.set(new Uint8Array(buffer), offset)
    offset += buffer.byteLength
  }
  if (offset !== output.byteLength) throw new Error('Reconstructed runtime size mismatch.')
  const outputBuffer = output.buffer as ArrayBuffer
  if ((await sha256(outputBuffer)) !== ffmpegRuntimeManifest.originalWasm.sha256)
    throw new Error('Reconstructed runtime integrity mismatch.')
  return output
}

export async function createFfmpegWasmObjectUrl(
  signal: AbortSignal,
  fetchRuntime: RuntimeFetch = fetch,
): Promise<string> {
  const wasm = await reconstructFfmpegWasm(signal, fetchRuntime)
  return URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }))
}

export const ffmpegCoreJavascriptUrl = `${ffmpegRuntimeManifest.basePath}/${ffmpegRuntimeManifest.javascript.fileName}`
