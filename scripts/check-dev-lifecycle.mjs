import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=', 2)
    return [key, value]
  }),
)
const mode = args.get('mode') === 'frontend' ? 'frontend' : 'all'
const cycles = Number.parseInt(args.get('cycles') ?? '1', 10)
const reloads = Number.parseInt(args.get('reloads') ?? '3', 10)
const timeoutMs = Number.parseInt(args.get('timeout-ms') ?? '30000', 10)
const verifyHmr = args.get('hmr') === 'true'
if (![cycles, reloads, timeoutMs].every(Number.isFinite) || cycles < 1 || reloads < 0) {
  throw new Error('cycles must be >= 1, reloads >= 0 and timeout-ms must be a number')
}

const root = fileURLToPath(new URL('..', import.meta.url))
const npmCli =
  process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const frontendOrigin = 'http://127.0.0.1:5173'
const workerOrigin = 'http://127.0.0.1:8787'
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
const cleanAnsi = (value) => value.replace(ansiPattern, '')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function assertPortFree(port) {
  await new Promise((resolvePromise, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`Port ${port} is already in use`)))
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePromise))
  })
}

async function waitForPortsFree(ports, timeout = 5_000) {
  const deadline = performance.now() + timeout
  let lastError
  while (performance.now() < deadline) {
    try {
      for (const port of ports) await assertPortFree(port)
      return
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw lastError
}

async function waitForHttp(origin, path, startedAt, deadline) {
  let lastError
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await response.arrayBuffer()
      return Math.round(performance.now() - startedAt)
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw new Error(`${path} was not ready within the lifecycle budget: ${lastError}`)
}

async function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('exit', resolvePromise)
      killer.once('error', resolvePromise)
    })
  } else {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      delay(3_000),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

async function requireHmrUpdate(path, expectedUrl, frames) {
  const original = await readFile(path)
  const firstNewFrame = frames.length
  try {
    await writeFile(
      path,
      Buffer.concat([original, Buffer.from('\n/* Vite HMR lifecycle check */\n')]),
    )
    const deadline = performance.now() + 5_000
    while (performance.now() < deadline) {
      if (
        frames
          .slice(firstNewFrame)
          .some((frame) => frame.includes('"type":"update"') && frame.includes(expectedUrl))
      ) {
        return
      }
      await delay(50)
    }
    throw new Error(`No Vite HMR update received for ${expectedUrl}`)
  } finally {
    await writeFile(path, original)
  }
}

async function runCycle(cycle) {
  await assertPortFree(5173)
  if (mode === 'all') await assertPortFree(8787)

  const startedAt = performance.now()
  const deadline = startedAt + timeoutMs
  const commandArgs =
    mode === 'all' ? ['run', 'dev:all'] : ['run', 'dev', '--', '--host', '127.0.0.1']
  const child = spawn(process.execPath, [npmCli, ...commandArgs], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const logs = []
  const timings = { cycle, mode }
  let expectedShutdown = false
  let unexpectedExit

  const readOutput = (stream) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      const output = cleanAnsi(chunk)
      logs.push(output)
      const elapsed = Math.round(performance.now() - startedAt)
      if (timings.viteReadyMs === undefined && /VITE v.*ready in/i.test(output)) {
        timings.viteReadyMs = elapsed
      }
      if (
        timings.workerReadyMs === undefined &&
        /Ready on http:\/\/127\.0\.0\.1:8787/i.test(output)
      ) {
        timings.workerReadyMs = elapsed
      }
      process.stdout.write(output)
    })
  }
  readOutput(child.stdout)
  readOutput(child.stderr)
  child.once('exit', (code, signal) => {
    if (!expectedShutdown) unexpectedExit = { code, signal }
  })

  let browser
  try {
    const probes = [
      ['htmlMs', frontendOrigin, '/'],
      ['mainMs', frontendOrigin, '/src/main.tsx'],
      ['stylesMs', frontendOrigin, '/src/styles.css'],
      ['roomsCssMs', frontendOrigin, '/src/features/rooms/rooms.css'],
      ['playbackCssMs', frontendOrigin, '/src/features/playback/playback.css'],
    ]
    if (mode === 'all') probes.push(['workerHealthMs', workerOrigin, '/api/health'])
    await Promise.all(
      probes.map(async ([name, origin, path]) => {
        timings[name] = await waitForHttp(origin, path, startedAt, deadline)
      }),
    )

    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const pageErrors = []
    const websocketFrames = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('websocket', (websocket) => {
      websocket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string') websocketFrames.push(payload)
      })
    })
    await page.goto(frontendOrigin, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, Math.round(deadline - performance.now())),
    })
    await page
      .locator('a[aria-label="Take Two ana sayfa"]')
      .waitFor({ state: 'visible', timeout: Math.max(1, Math.round(deadline - performance.now())) })
    timings.reactVisibleMs = Math.round(performance.now() - startedAt)

    if (verifyHmr) {
      const hmrStartedAt = performance.now()
      await requireHmrUpdate(join(root, 'src', 'styles.css'), '/src/styles.css', websocketFrames)
      await requireHmrUpdate(
        join(root, 'shared', 'scenes', 'catalog.ts'),
        '/src/features/scenes/SceneLibrary.tsx',
        websocketFrames,
      )
      timings.hmrMs = Math.round(performance.now() - hmrStartedAt)
    }

    for (let reload = 0; reload < reloads; reload += 1) {
      const reloadStartedAt = performance.now()
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
      await page
        .locator('a[aria-label="Take Two ana sayfa"]')
        .waitFor({ state: 'visible', timeout: 10_000 })
      timings[`reload${reload + 1}Ms`] = Math.round(performance.now() - reloadStartedAt)
      if (unexpectedExit)
        throw new Error(`Development process exited: ${JSON.stringify(unexpectedExit)}`)
      await waitForHttp(frontendOrigin, '/', performance.now(), performance.now() + 3_000)
      if (mode === 'all') {
        await waitForHttp(workerOrigin, '/api/health', performance.now(), performance.now() + 3_000)
      }
    }
    if (pageErrors.length) throw new Error(`Frontend page errors: ${pageErrors.join('; ')}`)
    if (unexpectedExit)
      throw new Error(`Development process exited: ${JSON.stringify(unexpectedExit)}`)
    console.log(`LIFECYCLE_RESULT ${JSON.stringify(timings)}`)
    return timings
  } catch (error) {
    const tail = logs.join('').slice(-8_000)
    throw new Error(
      `${error instanceof Error ? error.message : error}\nLast process output:\n${tail}`,
      { cause: error },
    )
  } finally {
    await browser?.close()
    expectedShutdown = true
    await stopProcessTree(child)
    await waitForPortsFree(mode === 'all' ? [5173, 8787] : [5173])
  }
}

const results = []
for (let cycle = 1; cycle <= cycles; cycle += 1) results.push(await runCycle(cycle))
console.log(`LIFECYCLE_SUMMARY ${JSON.stringify(results)}`)
