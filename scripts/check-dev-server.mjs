import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createServer } from 'vite'

const host = '127.0.0.1'
const port = 5199
const origin = `http://${host}:${port}`
const root = resolve(import.meta.dirname, '..')
const cacheDir = join(tmpdir(), `take-two-vite-health-${randomUUID()}`)
const fixtureId = randomUUID()
const watchFixtures = [
  join(root, 'src', `.vite-watch-${fixtureId}.ts`),
  join(root, 'shared', `.vite-watch-${fixtureId}.ts`),
]
const server = await createServer({
  cacheDir,
  optimizeDeps: { force: true },
  server: { host, port, strictPort: true },
})

async function waitForHttp(path, timeoutMs) {
  const startedAt = performance.now()
  const deadline = startedAt + timeoutMs
  let lastError
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await response.arrayBuffer()
      return Math.round(performance.now() - startedAt)
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
  }
  throw new Error(`${path} did not return HTTP 200 within ${timeoutMs} ms: ${lastError}`)
}

async function requireSourceWatching() {
  const pendingAdds = new Set(watchFixtures.map((path) => resolve(path)))
  const added = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Vite did not watch source fixtures: ${[...pendingAdds].join(', ')}`)),
      5_000,
    )
    const onAdd = (path) => {
      pendingAdds.delete(resolve(path))
      if (pendingAdds.size) return
      clearTimeout(timeout)
      server.watcher.off('add', onAdd)
      resolvePromise()
    }
    server.watcher.on('add', onAdd)
  })
  await Promise.all(watchFixtures.map((path) => writeFile(path, 'export {}\n')))
  await added
}

function inspectWatcherScope() {
  const watched = server.watcher.getWatched()
  const entries = Object.entries(watched).flatMap(([directory, names]) =>
    names.map((name) => resolve(directory, name)),
  )
  const excludedDescendant = entries.find((path) => {
    const normalized = relative(root, path).replaceAll('\\', '/')
    return (
      /(^|\/)(\.tools|local-test-media|\.wrangler|\.worker-build|\.ruff_cache)\/.+/.test(
        normalized,
      ) ||
      /(^|\/)ai\/(\.venv[^/]*|\.cache|\.tmp-pytest[^/]*)\/.+/.test(normalized) ||
      /(^|\/)(__pycache__|\.pytest_cache)\/.+/.test(normalized)
    )
  })
  if (excludedDescendant) {
    throw new Error(`Generated path is still present in Vite watcher scope: ${excludedDescendant}`)
  }
  return entries.length
}

let browser
try {
  await server.listen()
  const startedAt = performance.now()
  const [htmlMs, moduleMs, stylesMs, roomsCssMs, playbackCssMs] = await Promise.all(
    [
      '/',
      '/src/main.tsx',
      '/src/styles.css',
      '/src/features/rooms/rooms.css',
      '/src/features/playback/playback.css',
    ].map((path) => waitForHttp(path, 30_000)),
  )

  const { chromium } = await import('@playwright/test')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${origin}/scenes/a-small-step`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })
  await page
    .locator('a[aria-label="Take Two ana sayfa"]')
    .waitFor({ state: 'visible', timeout: 30_000 })
  const appMs = Math.round(performance.now() - startedAt)
  for (let reload = 0; reload < 3; reload += 1) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
    await page
      .locator('a[aria-label="Take Two ana sayfa"]')
      .waitFor({ state: 'visible', timeout: 10_000 })
  }
  if (pageErrors.length) throw new Error(`Frontend page errors: ${pageErrors.join('; ')}`)

  await requireSourceWatching()
  const watcherEntries = inspectWatcherScope()
  console.log(
    `Vite regression passed: / ${htmlMs} ms, main ${moduleMs} ms, CSS ${Math.max(stylesMs, roomsCssMs, playbackCssMs)} ms, React ${appMs} ms, ${watcherEntries} watched entries, 3 reloads`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await browser?.close()
  server.ws.close()
  server.httpServer?.closeAllConnections()
  await server.watcher.close()
  await Promise.all(watchFixtures.map((path) => rm(path, { force: true })))
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
}
