import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

async function installGeneratedMicrophone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          if (!constraints.audio) throw new DOMException('audio required', 'NotFoundError')
          const AudioContextConstructor =
            window.AudioContext ??
            (window as typeof window & { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext
          if (!AudioContextConstructor)
            throw new DOMException('AudioContext unavailable', 'NotSupportedError')
          const context = new AudioContextConstructor()
          const oscillator = context.createOscillator()
          const gain = context.createGain()
          const destination = context.createMediaStreamDestination()
          oscillator.frequency.value = 220
          gain.gain.value = 0.08
          oscillator.connect(gain).connect(destination)
          oscillator.start()
          setTimeout(() => {
            try {
              oscillator.stop()
            } catch {
              // The recorder may already have stopped this generated source.
            }
            void context.close()
          }, 10_000)
          return destination.stream
        },
      },
    })
  })
}

async function recordAndUploadAssignedLines(page: Page) {
  const timings = new Map<string, readonly [number, number, number]>([
    ['Ekip, tarihî bir an yaşıyoruz. Bari işi biliyormuş gibi görünün.', [0.5, 1, 5]],
    ['Bunun için bir düğme var mı?', [4.5, 5, 9]],
    ['Kontrol ettim. Doğru düğme dışında hepsine bastınız.', [9, 9.5, 14]],
    ['Harika. Seçenekleri tek tek eledik.', [14.5, 15, 19]],
    ['Ay’da neden parkmetre var?', [19.5, 20, 24]],
    ['Çünkü biri kısa süreli yörüngeyi seçmiş.', [24.5, 25, 29.5]],
  ])
  await page.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }).click()
  await page.getByRole('button', { name: 'Mikrofonu Dene' }).click()
  await page.getByRole('button', { name: 'Kayda Hazırım' }).click()
  const total = Number(
    (await page.locator('.line-counter strong').textContent())?.match(/\/ (\d+)/)?.[1],
  )
  expect(total).toBeGreaterThan(0)
  for (let index = 0; index < total; index++) {
    const text =
      (await page.locator('.guided-line-copy h2').textContent())?.replace(/[“”]/g, '') ?? ''
    const timing = timings.get(text)
    expect(timing).toBeTruthy()
    await page.getByRole('button', { name: 'İzlemeden geç' }).click()
    await page.getByRole('button', { name: 'Şimdi Seslendir' }).click()
    await page.locator('video').evaluate((element, start) => {
      const video = element as HTMLVideoElement
      video.currentTime = start as number
      video.dispatchEvent(new Event('timeupdate'))
    }, timing![0])
    await page.waitForTimeout(500)
    await page.locator('video').evaluate((element, start) => {
      const video = element as HTMLVideoElement
      video.currentTime = start as number
      video.dispatchEvent(new Event('timeupdate'))
    }, timing![1])
    await expect(page.getByText('ŞİMDİ KONUŞ')).toBeVisible()
    await page.waitForTimeout(300)
    await page.locator('video').evaluate((element, end) => {
      const video = element as HTMLVideoElement
      video.currentTime = end as number
      video.dispatchEvent(new Event('timeupdate'))
    }, timing![2])
    await expect(page.getByRole('heading', { name: 'Kaydın hazır' })).toBeVisible()
    await page.getByRole('button', { name: 'Onayla' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Tüm repliklerini tamamladın' })).toBeVisible()
}

async function inspectSharedVideo(page: Page) {
  const video = page.locator('.shared-result-page video')
  await expect(video).toBeVisible()
  return video.evaluate(async (element) => {
    const media = element as HTMLVideoElement
    if (media.readyState < HTMLMediaElement.HAVE_METADATA)
      await new Promise<void>((resolve, reject) => {
        media.addEventListener('loadedmetadata', () => resolve(), { once: true })
        media.addEventListener('error', () => reject(new Error('MP4 metadata failed')), {
          once: true,
        })
        media.load()
      })
    await media.play()
    await new Promise((resolve) => setTimeout(resolve, 300))
    media.pause()
    return {
      duration: media.duration,
      width: media.videoWidth,
      currentTime: media.currentTime,
    }
  })
}

async function downloadSharedVideo(page: Page) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: "MP4'ü İndir" }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).not.toBeNull()
  const bytes = await readFile(path!)
  return {
    bytes: bytes.byteLength,
    digest: createHash('sha256').update(bytes).digest('hex'),
    filename: download.suggestedFilename(),
  }
}

test('real ffmpeg result is committed and shared with a second authorized participant', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(10 * 60_000)
  const errors: string[] = []
  let ffmpegPartRequests = 0
  let legacyRuntimeRequests = 0
  page.on('console', (message) => {
    if (message.text().startsWith('[ffmpeg.wasm]')) console.info(message.text())
    if (message.text().startsWith('Yerel ffmpeg runtime tanısı')) console.info(message.text())
    if (message.text().startsWith('[dub-renderer]')) console.info(message.text())
    if (/worker\.js\?worker_file|optimize deps directory/i.test(message.text()))
      errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (/ffmpeg-core\.wasm\.part-\d{3}(?:\?|$)/.test(request.url())) ffmpegPartRequests++
    if (/\/api\/runtime\//.test(request.url())) legacyRuntimeRequests++
  })
  await installGeneratedMicrophone(page)

  await page.goto('/scenes/a-small-step')
  await page.getByRole('link', { name: 'Oda oluştur' }).click()
  await page.getByLabel('Takma adın').fill('Render Sunucusu')
  await page.getByRole('button', { name: 'Oda oluştur' }).click()
  await expect(page.getByRole('heading', { name: 'Sahne arkası.' })).toBeVisible()
  const roomUrl = page.url()

  const guestContext = await browser.newContext({ viewport: testInfo.project.use.viewport })
  const guest = await guestContext.newPage()
  guest.on('pageerror', (error) => errors.push(error.message))
  await installGeneratedMicrophone(guest)
  try {
    await guest.goto(roomUrl)
    await guest.getByLabel('Takma adın').fill('İzleyici')
    await guest.getByRole('button', { name: 'Odaya katıl' }).click()
    await guest.getByRole('button', { name: 'Hazırım' }).click()
    await page.getByRole('button', { name: 'Hazırım' }).click()
    await page.getByRole('button', { name: 'Oyunu Başlat' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
    await expect(guest.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
    await recordAndUploadAssignedLines(page)
    await recordAndUploadAssignedLines(guest)
    await expect(page.getByText('4 / 4 · Tamam')).toBeVisible()
    await expect(page.getByText('2 / 2 · Tamam')).toBeVisible()
    await page.getByRole('button', { name: 'Son Hazırlığı Başlat' }).click()
    await expect(page.getByRole('heading', { name: 'Dublaj videosunu hazırla' })).toBeVisible()
    await expect(guest.getByText('Sonucun hazırlanması bekleniyor')).toBeVisible()

    const renderStartedAt = Date.now()
    await page.getByRole('button', { name: "Yerel MP4'ü Hazırla" }).click()
    const finalReady = page.getByText('Odanın ortak final videosu hazır.')
    const renderFailure = page.getByText('Video hazırlanamadı.')
    await Promise.race([
      finalReady.waitFor({ state: 'visible', timeout: 9 * 60_000 }),
      renderFailure.waitFor({ state: 'visible', timeout: 9 * 60_000 }),
    ])
    if (await renderFailure.isVisible())
      throw new Error((await renderFailure.locator('..').textContent()) ?? 'Render failed')
    await expect(finalReady).toBeVisible()
    await expect(guest.getByText('Odanın ortak final videosu hazır.')).toBeVisible({
      timeout: 60_000,
    })
    const renderAndUploadDurationMs = Date.now() - renderStartedAt

    const [hostMedia, guestMedia] = await Promise.all([
      inspectSharedVideo(page),
      inspectSharedVideo(guest),
    ])
    const hostDownload = await downloadSharedVideo(page)
    expect(hostDownload.bytes).toBeGreaterThan(1_000)
    expect(hostMedia.duration).toBeGreaterThan(29)
    expect(hostMedia.width).toBeGreaterThan(0)
    expect(hostMedia.currentTime).toBeGreaterThan(0)
    expect(guestMedia.currentTime).toBeGreaterThan(0)
    expect(ffmpegPartRequests).toBe(2)
    expect(legacyRuntimeRequests).toBe(0)
    expect(errors).toEqual([])

    await guest.reload()
    await expect(guest.getByText('Odanın ortak final videosu hazır.')).toBeVisible()
    const restoredGuestMedia = await inspectSharedVideo(guest)
    expect(restoredGuestMedia.duration).toBe(hostMedia.duration)
    const guestDownload = await downloadSharedVideo(guest)
    expect(guestDownload.digest).toBe(hostDownload.digest)
    expect(guestDownload.bytes).toBe(hostDownload.bytes)
    expect(guestDownload.filename).toMatch(/^take-two-\d{6}\.mp4$/)

    const diagnostics = {
      sourceDurationSeconds: hostMedia.duration,
      recordingInputs: 6,
      outputBytes: hostDownload.bytes,
      renderAndUploadDurationMs,
      ffmpegPartRequests,
      legacyRuntimeRequests,
      participants: 2,
      sharedDigest: hostDownload.digest,
    }
    await testInfo.attach('phase9-render-diagnostics.json', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json',
    })
    console.info('Gerçek Faz 9 render/paylaşım tanısı', diagnostics)
  } finally {
    await guestContext.close()
  }
})
