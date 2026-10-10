import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.env.TAKETWO_AUDIT_ROOT ?? 'dist'
const maximumStaticBytes = 25 * 1024 * 1024
const forbiddenPath =
  /(?:^|[\\/])(?:\.tools|local-test-media|memory-bank|test-results|\.venv[^\\/]*|\.cache)(?:[\\/]|$)/i
const forbiddenContent =
  /HF_TOKEN|hf_[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|local-test-media|memory-bank/i
const manifest = JSON.parse(await readFile('shared/runtime/ffmpeg-manifest.json', 'utf8'))

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
    ),
  )
  return nested.flat()
}

const paths = await files(root)
const rows = []
for (const path of paths) {
  const content = await readFile(path)
  const name = relative(root, path).replaceAll('\\', '/')
  if (forbiddenPath.test(name)) throw new Error(`Forbidden deployment path: ${name}`)
  if (forbiddenContent.test(content.toString('latin1')))
    throw new Error(`Forbidden deployment content: ${name}`)
  if (/(?:^|\/)ffmpeg-core\.wasm$/i.test(name))
    throw new Error(`Monolithic ffmpeg WASM is forbidden: ${name}`)
  if (content.byteLength >= maximumStaticBytes)
    throw new Error(`Static asset is over 25 MiB: ${name}`)
  rows.push({ name, bytes: content.byteLength })
}

for (const configPath of ['wrangler.jsonc', 'wrangler.dev.jsonc']) {
  const config = await readFile(configPath, 'utf8')
  if (/r2_buckets|RUNTIME_ASSETS/.test(config))
    throw new Error(`Active R2 binding remains in ${configPath}.`)
}

const runtimeRoot = join(root, manifest.basePath.slice(1))
const runtimeFiles = [manifest.javascript, ...manifest.wasmParts]
for (const asset of runtimeFiles) {
  const content = await readFile(join(runtimeRoot, asset.fileName))
  if (content.byteLength !== asset.byteSize || digest(content) !== asset.sha256)
    throw new Error(`Runtime asset integrity mismatch: ${asset.fileName}`)
}
const reconstructed = Buffer.concat(
  await Promise.all(manifest.wasmParts.map((part) => readFile(join(runtimeRoot, part.fileName)))),
)
if (
  reconstructed.byteLength !== manifest.originalWasm.byteSize ||
  digest(reconstructed) !== manifest.originalWasm.sha256
)
  throw new Error('Reconstructed dist ffmpeg WASM integrity mismatch.')
if (rows.some((row) => /\/ffmpeg-core\.wasm$/i.test(row.name)))
  throw new Error('Unexpected monolithic ffmpeg-core.wasm appears in dist.')
rows.sort((a, b) => b.bytes - a.bytes)
const mainJs = rows.find((row) => /^assets\/index-.*\.js$/.test(row.name) && row.bytes > 100_000)
const css = rows.find((row) => row.name.endsWith('.css'))
console.log(
  JSON.stringify(
    {
      assetCount: rows.length,
      largest: rows.slice(0, 5),
      maximumBytes: rows[0]?.bytes ?? 0,
      mainJsBytes: mainJs?.bytes ?? 0,
      cssBytes: css?.bytes ?? 0,
      ffmpegRuntime: {
        coreVersion: manifest.coreVersion,
        partCount: manifest.wasmParts.length,
        reconstructedBytes: reconstructed.byteLength,
        reconstructedSha256: digest(reconstructed),
      },
    },
    null,
    2,
  ),
)
