import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('uploads, prepares and starts guided dubbing with a real private scene', async ({
  page,
}, testInfo) => {
  test.skip(Boolean(testInfo.project.use.isMobile), 'The real upload flow runs once on desktop.')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const state = { recorderStarts: 0, recorderStops: 0 }
    Object.defineProperty(window, '__studioRecorderState', { value: state })
    const stream = {
      getTracks: () => [{ stop: () => undefined }],
    } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => stream },
    })
    class BrowserMockAudioContext {
      state: AudioContextState = 'running'
      createAnalyser() {
        return {
          fftSize: 32,
          smoothingTimeConstant: 0,
          getByteTimeDomainData: (data: Uint8Array) => data.fill(145),
        }
      }
      createMediaStreamSource() {
        return { connect: () => undefined }
      }
      async close() {
        this.state = 'closed'
      }
    }
    class BrowserMockMediaRecorder {
      static isTypeSupported(mimeType: string) {
        return mimeType === 'audio/webm;codecs=opus'
      }
      readonly mimeType: string
      state: RecordingState = 'inactive'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onstop: ((event: Event) => void) | null = null
      constructor(
        readonly stream: MediaStream,
        options?: MediaRecorderOptions,
      ) {
        this.mimeType = options?.mimeType ?? ''
      }
      start() {
        this.state = 'recording'
        state.recorderStarts += 1
      }
      stop() {
        this.state = 'inactive'
        state.recorderStops += 1
        this.ondataavailable?.(
          new BlobEvent('dataavailable', {
            data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'tight line voice'], {
              type: this.mimeType,
            }),
          }),
        )
        this.onstop?.(new Event('stop'))
      }
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: BrowserMockAudioContext,
    })
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: BrowserMockMediaRecorder,
    })
  })
  await page.goto('/studio')
  await page
    .locator('input[type=file]')
    .setInputFiles(resolve('public/scenes/a-small-step/video.webm'))
  if (testInfo.project.name === 'webkit') {
    await expect(page.getByRole('alert')).toHaveText('Video tarayıcı tarafından okunamadı.')
    await expect(page.getByRole('button', { name: 'Videoyu özel alana yükle' })).toBeDisabled()
    expect(errors).toEqual([])
    return
  }
  await expect(page.getByText('video/webm')).toBeVisible()
  await expect(page.getByText('640×360')).toBeVisible()
  await expect(page.getByText(/karesinden özel küçük resim hazırlandı/i)).toBeVisible()
  await page.getByRole('button', { name: 'Videoyu özel alana yükle' }).click()
  await expect(page).toHaveURL(/\/studio\/private-[a-f0-9]{12}$/)

  await page.getByLabel('Sahne başlığı').fill('Tarayıcı Özel Sahnesi')
  await page.getByRole('button', { name: 'Karakter ekle' }).click()
  await page.getByRole('button', { name: 'Karakter ekle' }).click()
  await page.getByLabel('Karakter adı').nth(0).fill('Ada')
  await page.getByLabel('Karakter adı').nth(1).fill('Bora')

  await page.getByRole('button', { name: 'Replik ekle' }).click()
  let editor = page.locator('.line-editor')
  await editor.getByLabel('Replik metni').fill('Müsait misin?')
  await editor.getByLabel('Başlangıç (sn)').fill('0.000')
  await editor.getByLabel('Bitiş (sn)').fill('0.850')

  await page.getByRole('button', { name: 'Replik ekle' }).click()
  editor = page.locator('.line-editor')
  await editor.getByRole('button', { name: 'Bora' }).click()
  await editor.getByLabel('Replik metni').fill('Üst üste konuşabiliriz.')
  await editor.getByLabel('Başlangıç (sn)').fill('2.000')
  await editor.getByLabel('Bitiş (sn)').fill('4.000')
  const firstBlock = page.getByRole('button', { name: 'Ada: Müsait misin?' })
  const firstBlockBounds = await firstBlock.boundingBox()
  const timelineBounds = await page.getByLabel('Replik zaman çizelgesi').boundingBox()
  expect(firstBlockBounds).not.toBeNull()
  expect(timelineBounds).not.toBeNull()
  await page.mouse.move(
    firstBlockBounds!.x + firstBlockBounds!.width / 2,
    firstBlockBounds!.y + firstBlockBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(firstBlockBounds!.x + 20, timelineBounds!.y + 8 + 24 + 11, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Bora: Müsait misin?' })).toBeVisible()
  await page.getByRole('button', { name: 'Bora: Müsait misin?' }).click()
  await page.locator('.line-editor').getByRole('button', { name: 'Ada', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ada: Müsait misin?' })).toBeVisible()
  const restoredBounds = await page
    .getByRole('button', { name: 'Ada: Müsait misin?' })
    .boundingBox()
  expect(restoredBounds).not.toBeNull()
  await page.mouse.move(
    restoredBounds!.x + restoredBounds!.width / 2,
    restoredBounds!.y + restoredBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(timelineBounds!.x + timelineBounds!.width + 20, timelineBounds!.y + 43, {
    steps: 4,
  })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Ada: Müsait misin?' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sahne oynanmaya hazır' })).toBeVisible()
  await page.getByRole('button', { name: 'Zamanlı replikleri ön izle' }).click()
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.currentTime = 2.5
  })
  const subtitles = page.locator('.studio-subtitles')
  await expect(subtitles).toContainText('Üst üste konuşabiliriz.')
  await page.getByRole('button', { name: 'Oynanabilir özel sahne olarak kaydet' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Tarayıcı Özel Sahnesi' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 3, name: 'Tarayıcı Özel Sahnesi' })).toBeVisible()
  await expect(page.getByText('Küçük Bir Adım')).toHaveCount(0)
  const privateCard = page.getByRole('article').filter({ hasText: 'Tarayıcı Özel Sahnesi' })
  const thumbnail = privateCard.getByRole('img', { name: 'Tarayıcı Özel Sahnesi afişi' })
  await expect(thumbnail).toBeVisible()
  await expect
    .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(640)
  await expect
    .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalHeight))
    .toBe(360)
  await page.getByRole('link', { name: 'İncele: Tarayıcı Özel Sahnesi' }).click()
  await page.getByRole('link', { name: 'Oda oluştur' }).click()
  await page.getByLabel('Takma adın').fill('Host')
  await page.getByRole('button', { name: 'Oda oluştur' }).click()
  await expect(page.getByRole('heading', { name: 'Sahne arkası.' })).toBeVisible()
  await page.getByRole('button', { name: 'Hazırım' }).click()
  await page.getByRole('button', { name: 'Oyunu Başlat' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Tarayıcı Özel Sahnesi' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Atanan karakterlerin' })).toContainText('Ada')
  await expect(page.getByRole('list', { name: 'Atanan karakterlerin' })).toContainText('Bora')
  await expect(page.locator('video')).toBeVisible()
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.duration))
    .toBeGreaterThan(29)
  await page.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }).click()
  await page.getByRole('button', { name: 'Mikrofonu Dene' }).click()
  await page.getByRole('button', { name: 'Kayda Hazırım' }).click()
  await expect(page.getByText('Müsait misin?')).toBeVisible()
  await page.getByRole('button', { name: 'İzlemeden geç' }).click()
  await page.getByRole('button', { name: 'Şimdi Seslendir' }).click()
  const cue = page.locator('.speaking-cue')
  await expect(cue).toHaveText('3')
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __studioRecorderState: { recorderStarts: number }
          }
        ).__studioRecorderState.recorderStarts,
    ),
  ).toBe(0)
  await expect(cue).toHaveText('2', { timeout: 1_500 })
  await expect(cue).toHaveText('1', { timeout: 1_500 })
  await expect(cue).toHaveText('ŞİMDİ KONUŞ', { timeout: 1_500 })
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __studioRecorderState: { recorderStarts: number }
          }
        ).__studioRecorderState.recorderStarts,
    ),
  ).toBe(1)
  await expect(page.getByRole('button', { name: /Durdur/ })).toHaveCount(0)
  const guidedVideo = page.locator('video')
  await guidedVideo.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 0.85
    video.dispatchEvent(new Event('timeupdate'))
  })
  await expect(cue).toHaveText('Cümleni bitir')
  await guidedVideo.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 1.35
    video.dispatchEvent(new Event('timeupdate'))
  })
  await expect(page.getByRole('heading', { name: 'Kaydın hazır' })).toBeVisible()
  await page.getByRole('button', { name: 'Tekrar Kaydet' }).click()
  await page.getByRole('button', { name: 'İzlemeden geç' }).click()
  await page.getByRole('button', { name: 'Şimdi Seslendir' }).click()
  await expect(page.locator('.speaking-cue')).toHaveText('3')
  expect(errors).toEqual([])
})
