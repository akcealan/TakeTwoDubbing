import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('production static audit', () => {
  it('rejects a monolithic ffmpeg-core.wasm', async () => {
    const root = join(tmpdir(), `take-two-audit-${crypto.randomUUID()}`)
    created.push(root)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'ffmpeg-core.wasm'), new Uint8Array([0, 97, 115, 109]))
    await expect(
      execFileAsync(process.execPath, ['scripts/audit-dist.mjs'], {
        cwd: process.cwd(),
        env: { ...process.env, TAKETWO_AUDIT_ROOT: root },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('Monolithic ffmpeg WASM') })
  })
})
