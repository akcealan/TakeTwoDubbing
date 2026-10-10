import { MAX_MESSAGE_BYTES } from '../../shared/schemas/protocol'
import { RoomError } from '../domain/errors'

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof RoomError)
    return json({ code: error.code, message: error.message }, error.status)
  console.error('Worker request failed', error instanceof Error ? error.message : 'Unknown error')
  return json(
    { code: 'SERVER_ERROR', message: 'The room service had a problem. Please try again.' },
    500,
  )
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new RoomError('INVALID_INPUT', 'Send a JSON request.', 415)
  const reader = request.body?.getReader()
  if (!reader) throw new RoomError('INVALID_INPUT', 'A request body is required.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_MESSAGE_BYTES) {
        await reader.cancel()
        throw new RoomError('INVALID_INPUT', 'The request is too large.', 413)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown
  } catch {
    throw new RoomError('INVALID_INPUT', 'The request contains invalid JSON.')
  }
}

export function requireContentLength(request: Request, maximumBytes: number): number {
  const raw = request.headers.get('Content-Length')
  const size = raw === null ? Number.NaN : Number(raw)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new RoomError('INVALID_INPUT', 'A valid Content-Length header is required.', 411)
  if (size === 0) throw new RoomError('INVALID_INPUT', 'The upload body is empty.')
  if (size > maximumBytes)
    throw new RoomError('UPLOAD_TOO_LARGE', 'The upload exceeds the upload limit.', 413)
  return size
}
