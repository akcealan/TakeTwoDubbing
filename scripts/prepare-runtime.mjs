import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(projectRoot, 'shared/runtime/ffmpeg-manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const packageRoot = resolve(projectRoot, 'node_modules/@ffmpeg/core')
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
const sourceRoot = resolve(packageRoot, 'dist/esm')
const staticRoot = resolve(projectRoot, `public${manifest.basePath}`)
const staticLimitBytes = 25 * 1024 * 1024

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertArtifact(label, bytes, expected) {
  const actualHash = digest(bytes)
  if (bytes.byteLength !== expected.byteSize || actualHash !== expected.sha256)
    throw new Error(
      `${label} integrity mismatch (bytes ${bytes.byteLength}, SHA-256 ${actualHash}).`,
    )
}

async function writeIfChanged(path, bytes) {
  try {
    const current = await readFile(path)
    if (current.equals(bytes)) return false
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return true
}

export async function prepareRuntime({ verifyOnly = false } = {}) {
  if (packageJson.version !== manifest.coreVersion)
    throw new Error(
      `Expected @ffmpeg/core ${manifest.coreVersion}, found ${packageJson.version ?? 'unknown'}.`,
    )

  const javascript = await readFile(resolve(sourceRoot, manifest.javascript.fileName))
  const wasm = await readFile(resolve(sourceRoot, 'ffmpeg-core.wasm'))
  assertArtifact('Canonical ffmpeg JavaScript', javascript, manifest.javascript)
  assertArtifact('Canonical ffmpeg WASM', wasm, manifest.originalWasm)

  const totalPartBytes = manifest.wasmParts.reduce((sum, part) => sum + part.byteSize, 0)
  if (totalPartBytes !== manifest.originalWasm.byteSize)
    throw new Error('Runtime manifest part sizes do not equal the canonical WASM size.')

  let offset = 0
  const outputs = [
    [manifest.javascript.fileName, javascript],
    ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ]
  for (const part of manifest.wasmParts) {
    if (part.byteSize >= staticLimitBytes)
      throw new Error(`${part.fileName} reaches Cloudflare's 25 MiB per-file limit.`)
    const bytes = wasm.subarray(offset, offset + part.byteSize)
    assertArtifact(part.fileName, bytes, part)
    outputs.push([part.fileName, bytes])
    offset += part.byteSize
  }
  if (offset !== wasm.byteLength) throw new Error('Runtime split did not consume the full WASM.')

  let changed = 0
  for (const [fileName, expected] of outputs) {
    const path = resolve(staticRoot, fileName)
    if (verifyOnly) {
      const actual = await readFile(path)
      if (!actual.equals(expected)) throw new Error(`Prepared runtime mismatch: ${fileName}`)
    } else if (await writeIfChanged(path, expected)) changed += 1
  }

  const reconstructed = Buffer.concat(
    await Promise.all(
      manifest.wasmParts.map((part) => readFile(resolve(staticRoot, part.fileName))),
    ),
  )
  assertArtifact('Reconstructed prepared ffmpeg WASM', reconstructed, manifest.originalWasm)
  console.log(
    `ffmpeg core ${manifest.coreVersion}: ${manifest.wasmParts.length} static parts, ${reconstructed.byteLength} bytes, SHA-256 ${digest(reconstructed)} (${verifyOnly ? 'verified' : `${changed} files updated`}).`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareRuntime({ verifyOnly: process.argv.includes('--verify-only') }).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
