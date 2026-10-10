import { expect, test } from '@playwright/test'
import { ffmpegRuntimeManifest } from '../../shared/runtime/ffmpegRuntime'

test('single Worker serves SPA, API, WebSocket and multipart static runtime', async ({
  page,
  request,
}) => {
  const contactedLocalAi: string[] = []
  page.on('request', (entry) => {
    if (/127\.0\.0\.1:8765|localhost:8765/.test(entry.url())) contactedLocalAi.push(entry.url())
  })
  const root = await request.get('/')
  expect(root.status()).toBe(200)
  const deepLink = await page.goto('/scenes/not-present/create')
  expect(deepLink?.status()).toBe(200)
  await expect(page.getByText('Take Two').first()).toBeVisible()
  expect(contactedLocalAi).toEqual([])

  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)
  expect(health.headers()['content-security-policy']).toContain("worker-src 'self' blob:")
  expect(health.headers()['content-security-policy']).toContain("connect-src 'self' blob:")
  expect(health.headers()['content-security-policy']).toContain(
    "script-src 'self' 'wasm-unsafe-eval'",
  )
  expect(health.headers()['content-security-policy']).not.toContain("'unsafe-eval'")
  expect(health.headers()['permissions-policy']).toContain('microphone=(self)')

  const runtimeJs = await request.get(
    `${ffmpegRuntimeManifest.basePath}/${ffmpegRuntimeManifest.javascript.fileName}`,
  )
  expect(runtimeJs.status()).toBe(200)
  expect(runtimeJs.headers()['content-type']).toContain('text/javascript')
  expect(runtimeJs.headers()['cache-control']).toBe(
    'public, max-age=31536000, immutable, no-transform',
  )
  expect((await runtimeJs.body()).byteLength).toBe(ffmpegRuntimeManifest.javascript.byteSize)

  const reconstructed = await page.evaluate(async (runtimeManifest) => {
    const output = new Uint8Array(runtimeManifest.originalWasm.byteSize)
    let offset = 0
    const partResults = []
    for (const part of runtimeManifest.wasmParts) {
      const response = await fetch(`${runtimeManifest.basePath}/${part.fileName}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      output.set(bytes, offset)
      offset += bytes.byteLength
      partResults.push({
        ok: response.ok,
        bytes: bytes.byteLength,
        type: response.headers.get('content-type'),
        cache: response.headers.get('cache-control'),
      })
    }
    const digest = await crypto.subtle.digest('SHA-256', output)
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')
    return { bytes: output.byteLength, hash, partResults }
  }, ffmpegRuntimeManifest)
  expect(reconstructed.bytes).toBe(ffmpegRuntimeManifest.originalWasm.byteSize)
  expect(reconstructed.hash).toBe(ffmpegRuntimeManifest.originalWasm.sha256)
  expect(reconstructed.partResults).toEqual(
    ffmpegRuntimeManifest.wasmParts.map((part) => ({
      ok: true,
      bytes: part.byteSize,
      type: 'application/octet-stream',
      cache: 'public, max-age=31536000, immutable, no-transform',
    })),
  )
  expect((await request.get('/api/runtime/ffmpeg-core.wasm')).status()).toBe(404)

  const created = await request.post('/api/rooms', {
    data: { sceneId: 'a-small-step', nickname: 'Üretim Dumanı' },
  })
  expect(created.status()).toBe(201)
  const session = (await created.json()) as {
    code: string
    roomId: string
    playerId: string
    token: string
  }
  const roomState = await page.evaluate(async (saved) => {
    return await new Promise<{ code: string }>((resolve, reject) => {
      const socket = new WebSocket(
        `${location.origin.replace(/^http/, 'ws')}/api/rooms/${saved.code}/socket`,
      )
      const timeout = window.setTimeout(() => reject(new Error('WebSocket timeout')), 5_000)
      socket.addEventListener('open', () =>
        socket.send(JSON.stringify({ type: 'AUTH', session: saved })),
      )
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as {
          type?: string
          payload?: { code: string }
        }
        if (message.type === 'ROOM_STATE' && message.payload) {
          window.clearTimeout(timeout)
          socket.close()
          resolve(message.payload)
        }
      })
      socket.addEventListener('error', () => reject(new Error('WebSocket failed')))
    })
  }, session)
  expect(roomState.code).toBe(session.code)
})
