import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const base = process.env.TAKETWO_PRODUCTION_URL?.replace(/\/$/, '')
if (!base) throw new Error('Set TAKETWO_PRODUCTION_URL to the deployed workers.dev origin.')
const manifest = JSON.parse(await readFile('shared/runtime/ffmpeg-manifest.json', 'utf8'))

for (const [path, expectedType] of [
  ['/api/health', 'application/json'],
  ['/scenes/deployment-smoke', 'text/html'],
  [`${manifest.basePath}/${manifest.javascript.fileName}`, 'text/javascript'],
]) {
  const response = await fetch(`${base}${path}`)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  if (!response.headers.get('content-type')?.includes(expectedType))
    throw new Error(`${path} returned an unexpected Content-Type`)
  if (!response.headers.get('x-content-type-options'))
    throw new Error(`${path} is missing production security headers`)
}
const parts = []
for (const part of manifest.wasmParts) {
  const path = `${manifest.basePath}/${part.fileName}`
  const response = await fetch(`${base}${path}`)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== part.byteSize || hash !== part.sha256)
    throw new Error(`${path} failed size/integrity verification`)
  parts.push(bytes)
}
const reconstructed = Buffer.concat(parts)
const reconstructedHash = createHash('sha256').update(reconstructed).digest('hex')
if (
  reconstructed.byteLength !== manifest.originalWasm.byteSize ||
  reconstructedHash !== manifest.originalWasm.sha256
)
  throw new Error('Deployed multipart ffmpeg runtime failed reconstruction verification.')
console.log('Deployed read-only smoke passed.')
