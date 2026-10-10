import { expect, test } from '@playwright/test'

const windows = [
  [1, 5],
  [5, 9],
  [9.5, 14],
  [15, 19],
  [20, 24],
  [25, 29.5],
] as const

test('player completes the guided canonical dubbing flow without a physical microphone', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Rehberli mikrofon ve yükleme akışı masaüstü Chromium QA testidir.',
  )

  await page.addInitScript(() => {
    const microphoneState = { requests: 0, stoppedTracks: 0, recorderStarts: 0, recorderStops: 0 }
    Object.defineProperty(window, '__guidedMicrophoneState', { value: microphoneState })
    const stream = {
      getTracks: () => [
        {
          stop: () => {
            microphoneState.stoppedTracks += 1
          },
        },
      ],
    } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          if (!constraints.audio) throw new DOMException('audio required', 'NotFoundError')
          microphoneState.requests += 1
          return stream
        },
      },
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
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: BrowserMockAudioContext,
    })

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
        microphoneState.recorderStarts += 1
      }
      stop() {
        this.state = 'inactive'
        microphoneState.recorderStops += 1
        this.ondataavailable?.(
          new BlobEvent('dataavailable', {
            data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'mock microphone voice'], {
              type: this.mimeType,
            }),
          }),
        )
        this.onstop?.(new Event('stop'))
      }
    }
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: BrowserMockMediaRecorder,
    })
  })

  await page.goto('/scenes/a-small-step')
  await page.getByRole('link', { name: 'Oda oluştur' }).click()
  await page.getByLabel('Takma adın').fill('Sesçi')
  await page.getByRole('button', { name: 'Oda oluştur' }).click()
  await page.getByRole('button', { name: 'Hazırım' }).click()
  await page.getByRole('button', { name: 'Oyunu Başlat' }).click()

  await expect(page.getByRole('heading', { name: 'Sahneyi özgün hâliyle izle' })).toBeVisible()
  await expect(page.getByText(/geliştirme videosu sessizdir/)).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __guidedMicrophoneState: { requests: number } })
          .__guidedMicrophoneState.requests,
    ),
  ).toBe(0)
  await page.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }).click()
  await page.getByRole('button', { name: 'Mikrofonu Dene' }).click()
  await expect(page.getByText('Sesin geliyor')).toBeVisible()
  await page.getByRole('button', { name: 'Kayda Hazırım' }).click()

  for (let index = 0; index < windows.length; index++) {
    await expect(page.getByText(`Replik ${index + 1} / 6`)).toBeVisible()
    await page.getByRole('button', { name: 'İzlemeden geç' }).click()
    await page.getByRole('button', { name: 'Şimdi Seslendir' }).click()
    const video = page.locator('video')
    await expect(video).toHaveJSProperty('muted', true)
    if (index === 0) {
      await expect(page.locator('.speaking-cue')).toHaveText('3')
      await expect(page.getByText('ŞİMDİ KONUŞ')).toBeVisible({ timeout: 4_000 })
    } else {
      await video.evaluate((element, start) => {
        const media = element as HTMLVideoElement
        media.currentTime = start as number
        media.dispatchEvent(new Event('timeupdate'))
      }, windows[index]![0])
      await expect(page.getByText('ŞİMDİ KONUŞ')).toBeVisible()
    }
    await expect(page.getByText(/Kalan konuşma süresi/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Durdur/ })).toHaveCount(0)
    await video.evaluate((element, end) => {
      const media = element as HTMLVideoElement
      media.currentTime = end as number
      media.dispatchEvent(new Event('timeupdate'))
    }, windows[index]![1])
    await expect(page.getByRole('heading', { name: 'Kaydın hazır' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Dinle' })).toBeVisible()
    await page.getByRole('button', { name: 'Onayla' }).click()
  }

  await expect(page.getByRole('heading', { name: 'Tüm repliklerini tamamladın' })).toBeVisible()
  await expect(page.getByText('6 / 6 · Tamam')).toBeVisible()
  const state = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __guidedMicrophoneState: {
            requests: number
            stoppedTracks: number
            recorderStarts: number
            recorderStops: number
          }
        }
      ).__guidedMicrophoneState,
  )
  expect(state).toEqual({ requests: 7, stoppedTracks: 7, recorderStarts: 6, recorderStops: 6 })

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Tüm repliklerini tamamladın' })).toBeVisible()
  await page.getByRole('button', { name: 'Son Hazırlığı Başlat' }).click()
  await expect(page.getByRole('heading', { name: 'Dublaj videosunu hazırla' })).toBeVisible()
})
