import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

async function installGeneratedMicrophone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const context = new AudioContext()
          const oscillator = context.createOscillator()
          const gain = context.createGain()
          const destination = context.createMediaStreamDestination()
          oscillator.frequency.value = 260
          gain.gain.value = 0.08
          oscillator.connect(gain).connect(destination)
          oscillator.start()
          setTimeout(() => {
            try {
              oscillator.stop()
            } catch {
              // The generated microphone may already be stopped.
            }
            void context.close()
          }, 15_000)
          return destination.stream
        },
      },
    })
  })
}

test('private scene/background, room freeze, recording, render, result and cleanup stay R2-free', async ({
  page,
}, testInfo) => {
  test.setTimeout(12 * 60_000)
  await installGeneratedMicrophone(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.text().startsWith('[ffmpeg.wasm]')) console.info(message.text())
  })

  await page.goto('/studio')
  await page
    .locator('input[type=file]')
    .setInputFiles(resolve('local-test-media/clip1-speaker-regression.mp4'))
  await expect(page.getByText('21.14 MB')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Videoyu özel alana yükle' }).click()
  await expect(page).toHaveURL(/\/studio\/private-[a-f0-9]{12}$/)
  const sceneId = new URL(page.url()).pathname.split('/').at(-1)!
  const studioToken = await page.evaluate(() => localStorage.getItem('take-two-scene-studio-key'))
  expect(studioToken).toMatch(/^[a-f0-9]{64}$/)

  const background = await readFile('local-test-media/product-background-real.m4a')
  const backgroundUpload = await page.request.post(
    new URL(`/api/private-scenes/${sceneId}/background`, testInfo.project.use.baseURL).toString(),
    {
      headers: {
        Origin: String(testInfo.project.use.baseURL),
        Authorization: `Bearer ${studioToken}`,
        'Content-Type': 'audio/mp4',
        'X-Background-Duration-Ms': '42121',
        'X-Background-Sample-Rate': '44100',
        'X-Background-Channels': '2',
        'X-Background-Provider': encodeURIComponent('local-smoke-fixture'),
        'X-Background-Provider-Version': encodeURIComponent('1'),
        'X-Background-Model': encodeURIComponent('pre-accepted-local-background'),
        'X-Background-Device': 'cpu',
      },
      data: background,
    },
  )
  expect(backgroundUpload.status()).toBe(201)
  await page.reload()
  await expect(page.getByText(/Kaydedilmiş arka plan hazır/i)).toBeVisible()

  await page.getByLabel('Sahne başlığı').fill('R2 Olmadan Yerel Smoke')
  await page.getByRole('button', { name: 'Karakter ekle' }).click()
  await page.getByLabel('Karakter adı').fill('Test Oyuncusu')
  await page.getByRole('button', { name: 'Replik ekle' }).click()
  await page.getByLabel('Replik metni').fill('Yerel ve özel depolama testi.')
  await page.getByRole('button', { name: 'Oynanabilir özel sahne olarak kaydet' }).click()

  await expect(
    page.getByRole('heading', { level: 1, name: 'R2 Olmadan Yerel Smoke' }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Oda oluştur' }).click()
  await page.getByLabel('Takma adın').fill('Yerel Smoke')
  await page.getByRole('button', { name: 'Oda oluştur' }).click()
  await expect(page.getByRole('heading', { name: 'Sahne arkası.' })).toBeVisible()
  const roomCode = new URL(page.url()).pathname.split('/').at(-1)!

  // Room source/background are already frozen; deleting the reusable scene cannot affect the room.
  const sceneDelete = await page.request.delete(
    new URL(`/api/private-scenes/${sceneId}`, testInfo.project.use.baseURL).toString(),
    {
      headers: {
        Origin: String(testInfo.project.use.baseURL),
        Authorization: `Bearer ${studioToken}`,
      },
    },
  )
  expect(sceneDelete.status()).toBe(204)

  await page.getByRole('button', { name: 'Hazırım' }).click()
  await page.getByRole('button', { name: 'Oyunu Başlat' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'R2 Olmadan Yerel Smoke' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }).click()
  await page.getByRole('button', { name: 'Mikrofonu Dene' }).click()
  await page.getByRole('button', { name: 'Kayda Hazırım' }).click()
  await page.getByRole('button', { name: 'İzlemeden geç' }).click()
  await page.getByRole('button', { name: 'Şimdi Seslendir' }).click()
  await expect(page.getByRole('heading', { name: 'Kaydın hazır' })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: 'Onayla' }).click()
  await expect(page.getByRole('heading', { name: 'Tüm repliklerini tamamladın' })).toBeVisible()
  await page.getByRole('button', { name: 'Son Hazırlığı Başlat' }).click()
  await expect(page.getByRole('heading', { name: 'Dublaj videosunu hazırla' })).toBeVisible()

  const renderStartedAt = Date.now()
  await page.getByRole('button', { name: "Yerel MP4'ü Hazırla" }).click()
  await expect(page.getByText('Odanın ortak final videosu hazır.')).toBeVisible({
    timeout: 9 * 60_000,
  })
  const renderAndUploadDurationMs = Date.now() - renderStartedAt
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: "MP4'ü İndir" }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  const result = await readFile(downloadPath!)
  expect(result.byteLength).toBeGreaterThan(1_000_000)

  const cleanupStatus = await page.evaluate(async (code) => {
    const session = JSON.parse(sessionStorage.getItem(`take-two:room:${code}`) ?? 'null') as {
      roomId: string
      playerId: string
      token: string
    } | null
    if (!session) return 0
    const response = await fetch(`/api/rooms/${code}/source-video`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        'X-Room-Id': session.roomId,
        'X-Player-Id': session.playerId,
      },
    })
    return response.status
  }, roomCode)
  expect(cleanupStatus).toBe(404)
  expect(errors).toEqual([])

  const diagnostics = {
    sourceBytes: (await readFile('local-test-media/clip1-speaker-regression.mp4')).byteLength,
    backgroundBytes: background.byteLength,
    resultBytes: result.byteLength,
    resultSha256: createHash('sha256').update(result).digest('hex'),
    renderAndUploadDurationMs,
    sceneDeletedAfterRoomFreeze: true,
    postFinalRoomSourceStatus: cleanupStatus,
  }
  await testInfo.attach('r2-free-media-real-diagnostics.json', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  })
  console.info('R2-free media local smoke', diagnostics)
})
