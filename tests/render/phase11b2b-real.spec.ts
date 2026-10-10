import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

test.skip(
  process.env.PHASE11B2B_REAL !== '1',
  'Opt-in test: requires a running local separator model and private regression media.',
)

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

test('real private clip flows through Studio separation, frozen background and final render', async ({
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
  await expect(
    page.getByRole('heading', { name: /Yeni sahne hazırla|clip1-speaker-regression/ }),
  ).toBeVisible({
    timeout: 60_000,
  })

  await page.getByRole('button', { name: 'Konuşmaları Ayır' }).click()
  await expect(page.getByLabel('Konuşmasız arka plan ön izlemesi')).toBeVisible({
    timeout: 3 * 60_000,
  })
  await page.getByRole('button', { name: 'Arka Planı Kullan' }).click()
  await expect(page.getByText(/özel olarak kaydedildi/i)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Kaydedilmiş arka plan hazır/i)).toBeVisible()

  await page.getByLabel('Sahne başlığı').fill('Gerçek Arka Plan Testi')
  await page.getByRole('button', { name: 'Karakter ekle' }).click()
  await page.getByLabel('Karakter adı').fill('Test Oyuncusu')
  await page.getByRole('button', { name: 'Replik ekle' }).click()
  await page.getByLabel('Replik metni').fill('Bu, gerçek final karışımı için deneme repliğidir.')
  await page.getByRole('button', { name: 'Oynanabilir özel sahne olarak kaydet' }).click()

  await expect(
    page.getByRole('heading', { level: 1, name: 'Gerçek Arka Plan Testi' }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Oda oluştur' }).click()
  await page.getByLabel('Takma adın').fill('Gerçek Test')
  await page.getByRole('button', { name: 'Oda oluştur' }).click()
  await page.getByRole('button', { name: 'Hazırım' }).click()
  await page.getByRole('button', { name: 'Oyunu Başlat' }).click()

  await expect(
    page.getByRole('heading', { level: 1, name: 'Gerçek Arka Plan Testi' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }).click()
  await page.getByRole('button', { name: 'Mikrofonu Dene' }).click()
  await page.getByRole('button', { name: 'Kayda Hazırım' }).click()
  await page.getByRole('button', { name: 'İzlemeden geç' }).click()
  await page.getByRole('button', { name: 'Şimdi Seslendir' }).click()
  await expect(page.getByRole('heading', { name: 'Kaydın hazır' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Onayla' }).click()
  await expect(page.getByRole('heading', { name: 'Tüm repliklerini tamamladın' })).toBeVisible()
  await page.getByRole('button', { name: 'Son Hazırlığı Başlat' }).click()
  await expect(page.getByRole('heading', { name: 'Dublaj videosunu hazırla' })).toBeVisible()

  const manifestFacts = await page.locator('.render-panel').evaluate(() => {
    const text = document.body.textContent ?? ''
    return { mentionsBackground: text.includes('arka plan') }
  })
  await page.getByRole('button', { name: "Yerel MP4'ü Hazırla" }).click()
  const renderSuccess = page.getByText('Odanın ortak final videosu hazır.')
  const renderFailure = page.locator('.status--error')
  await expect(renderSuccess.or(renderFailure)).toBeVisible({
    timeout: 9 * 60_000,
  })
  if (await renderFailure.isVisible())
    throw new Error(`Final render failed: ${await renderFailure.textContent()}`)
  const media = await page.locator('.shared-result-page video').evaluate(async (element) => {
    const video = element as HTMLVideoElement
    if (video.readyState < HTMLMediaElement.HAVE_METADATA)
      await new Promise<void>((resolveLoaded, reject) => {
        video.addEventListener('loadedmetadata', () => resolveLoaded(), { once: true })
        video.addEventListener('error', () => reject(new Error('final metadata failed')), {
          once: true,
        })
        video.load()
      })
    const bytes = await fetch(video.src).then((response) => response.arrayBuffer())
    return { bytes: bytes.byteLength, duration: video.duration }
  })
  expect(media.bytes).toBeGreaterThan(1_000_000)
  expect(media.duration).toBeGreaterThan(41)
  expect(manifestFacts.mentionsBackground).toBe(true)
  expect(errors).toEqual([])
  await testInfo.attach('phase11b2b-real-diagnostics.json', {
    body: JSON.stringify({ ...media, manifestFacts }, null, 2),
    contentType: 'application/json',
  })
})
