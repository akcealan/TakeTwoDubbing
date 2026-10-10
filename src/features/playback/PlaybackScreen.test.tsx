import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room } from '../../../shared/types'
import { getSceneById } from '../../../shared/scenes/catalog'
import { uploadLineRecording } from '../../lib/api/rooms'
import { PlaybackScreen } from './PlaybackScreen'

vi.mock('../../lib/api/rooms', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/rooms')>()),
  uploadLineRecording: vi.fn(),
}))

const playerId = '00000000-0000-4000-8000-000000000002'
const otherId = '00000000-0000-4000-8000-000000000003'

function makeRoom(characterIds: string[], overrides: Partial<Room> = {}): Room {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    code: '012345',
    sceneId: 'a-small-step',
    hostId: playerId,
    status: 'playing',
    startedAt: 1234,
    players: [
      { id: playerId, nickname: 'Oyuncu', connected: true, ready: true, characterIds },
      { id: otherId, nickname: 'Arkadaş', connected: true, ready: true, characterIds: ['pip'] },
    ],
    recordingProgress: {
      totalRequired: 6,
      totalUploaded: 0,
      remaining: 6,
      readyForFinalization: false,
      players: [
        {
          playerId,
          required: characterIds.length ? 4 : 0,
          uploaded: 0,
          remaining: characterIds.length ? 4 : 0,
          complete: !characterIds.length,
          spectator: !characterIds.length,
        },
        {
          playerId: otherId,
          required: 2,
          uploaded: 0,
          remaining: 2,
          complete: false,
          spectator: false,
        },
      ],
    },
    recordings: [],
    expiresAt: Date.now() + 10_000,
    revision: 3,
    ...overrides,
  }
}

class MockMediaRecorder {
  static isTypeSupported = (mime: string) => mime === 'audio/webm;codecs=opus'
  static instances: MockMediaRecorder[] = []
  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? ''
    MockMediaRecorder.instances.push(this)
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

class MockAnalyser {
  fftSize = 256
  smoothingTimeConstant = 0
  connect() {
    return this
  }
  getByteTimeDomainData(samples: Uint8Array) {
    samples.fill(140)
  }
}

class MockAudioContext {
  state: AudioContextState = 'running'
  createAnalyser() {
    return new MockAnalyser() as unknown as AnalyserNode
  }
  createMediaStreamSource() {
    return { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode
  }
  close = vi.fn(async () => {
    this.state = 'closed'
  })
}

const trackStop = vi.fn()
const getUserMedia = vi.fn(
  async () => ({ getTracks: () => [{ stop: trackStop }] }) as unknown as MediaStream,
)

function renderPlayback(room = makeRoom(['nova', 'echo']), onFinalize = vi.fn()) {
  return render(
    <PlaybackScreen
      room={room}
      session={{ code: room.code, roomId: room.id, playerId, token: 'a'.repeat(64) }}
      connectionStatus="connected"
      connectionError={null}
      saved
      onLeave={vi.fn()}
      onReconnect={vi.fn()}
      onFinalize={onFinalize}
    />,
  )
}

async function enterLineFlow() {
  fireEvent.click(screen.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }))
  fireEvent.click(screen.getByRole('button', { name: 'Mikrofonu Dene' }))
  await screen.findByRole('button', { name: 'Kayda Hazırım' })
  fireEvent.click(screen.getByRole('button', { name: 'Kayda Hazırım' }))
}

describe('guided playback screen', () => {
  beforeEach(() => {
    MockMediaRecorder.instances = []
    trackStop.mockClear()
    getUserMedia.mockClear()
    vi.mocked(uploadLineRecording).mockReset()
    vi.stubGlobal('MediaRecorder', MockMediaRecorder as unknown as typeof MediaRecorder)
    vi.stubGlobal('AudioContext', MockAudioContext as unknown as typeof AudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:take'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(
      HTMLMediaElement.HAVE_METADATA,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('moves from full-scene preview through microphone test into one canonical owned line', async () => {
    renderPlayback()
    expect(screen.getByRole('heading', { name: 'Sahneyi özgün hâliyle izle' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Atanan karakterlerin' })).toHaveTextContent(
      'Kaptan Nova',
    )
    expect(screen.getByRole('list', { name: 'Atanan karakterlerin' })).toHaveTextContent('ECHO')
    expect(getUserMedia).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }))
    expect(
      screen.getByRole('heading', { name: 'Sesini birlikte kontrol edelim' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mikrofonu Dene' }))
    expect(await screen.findByRole('button', { name: 'Kayda Hazırım' })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Mikrofon ses seviyesi' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Kayda Hazırım' }))
    expect(screen.getByText('Replik 1 / 4')).toBeInTheDocument()
    expect(screen.getByText(/Ekip, tarihî bir an/)).toBeInTheDocument()
    expect(trackStop).toHaveBeenCalledOnce()
  })

  it('lets a spectator preview the scene but bypasses microphone and recording', () => {
    renderPlayback(makeRoom([]))
    fireEvent.click(screen.getByRole('button', { name: 'Sahneyi İzlemeyi Bitir' }))
    expect(
      screen.getByRole('heading', { name: 'Bu turda seslendireceğin bir karakter yok.' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mikrofonu Dene' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Şimdi Seslendir' })).not.toBeInTheDocument()
  })

  it('skips already uploaded owned lines after reconnect and shows authoritative player progress', async () => {
    renderPlayback(
      makeRoom(['nova', 'echo'], {
        recordings: [
          {
            recordingId: '00000000-0000-4000-8000-000000000010',
            lineId: 'step-1',
            playerId,
            mimeType: 'audio/webm;codecs=opus',
            byteSize: 10,
            durationMs: 3500,
            uploadedAt: 1,
          },
        ],
        recordingProgress: {
          totalRequired: 6,
          totalUploaded: 1,
          remaining: 5,
          readyForFinalization: false,
          players: [
            { playerId, required: 4, uploaded: 1, remaining: 3, complete: false, spectator: false },
            {
              playerId: otherId,
              required: 2,
              uploaded: 0,
              remaining: 2,
              complete: false,
              spectator: false,
            },
          ],
        },
      }),
    )
    await enterLineFlow()
    expect(screen.getByText('Replik 2 / 4')).toBeInTheDocument()
    expect(screen.getByText(/Kontrol ettim/)).toBeInTheDocument()
    expect(screen.getByTestId('player-Oyuncu')).toHaveTextContent('1 / 4')
    expect(
      screen.getByText('Diğer oyuncuların kayıtları final videoya kadar gizli.'),
    ).toBeInTheDocument()
  })

  it('clamps first-line context to scene start and keeps source media unmuted', async () => {
    renderPlayback()
    await enterLineFlow()
    fireEvent.click(screen.getByRole('button', { name: 'Önce sahneyi izle' }))
    const video = document.querySelector('video')!
    expect(video.currentTime).toBe(0)
    expect(video.muted).toBe(false)
    expect(screen.getByText(/Kaynak sesi açık/)).toBeInTheDocument()
  })

  it('runs a full countdown for a line at zero and repeats it when re-recording', async () => {
    const sourceScene = getSceneById('a-small-step')!
    const firstLine = {
      ...sourceScene.lines[0]!,
      startMs: 0,
      endMs: 850,
      text: 'Müsait misin?',
    }
    renderPlayback(
      makeRoom(['nova'], {
        sceneId: 'early-scene',
        sceneSnapshot: {
          ...sourceScene,
          id: 'early-scene',
          durationMs: 15_000,
          lines: [firstLine],
        },
      }),
    )
    await enterLineFlow()
    fireEvent.click(screen.getByRole('button', { name: 'İzlemeden geç' }))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Şimdi Seslendir' }))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(MockMediaRecorder.instances[0]?.state).toBe('inactive')
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(screen.getByText('2')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(screen.getByText('1')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(screen.getByText('ŞİMDİ KONUŞ')).toBeInTheDocument()
    expect(MockMediaRecorder.instances[0]?.state).toBe('recording')
    const video = document.querySelector('video')!
    expect(video.currentTime).toBe(0)
    act(() => {
      video.currentTime = 1.35
      fireEvent.timeUpdate(video)
    })
    vi.useRealTimers()
    await screen.findByRole('heading', { name: 'Kaydın hazır' })
    fireEvent.click(screen.getByRole('button', { name: 'Tekrar Kaydet' }))
    fireEvent.click(screen.getByRole('button', { name: 'İzlemeden geç' }))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Şimdi Seslendir' }))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(MockMediaRecorder.instances).toHaveLength(2)
  })

  it('mutes source, follows media time, records the grace window, reviews and advances after upload', async () => {
    vi.mocked(uploadLineRecording).mockResolvedValue({
      recordingId: '00000000-0000-4000-8000-000000000010',
      lineId: 'step-1',
      playerId,
      mimeType: 'audio/webm;codecs=opus',
      byteSize: 5,
      durationMs: 3500,
      uploadedAt: 1,
    })
    renderPlayback()
    await enterLineFlow()
    fireEvent.click(screen.getByRole('button', { name: 'İzlemeden geç' }))
    const video = document.querySelector('video')!
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Şimdi Seslendir' }))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(video.muted).toBe(true)
    expect(MockMediaRecorder.instances[0]?.state).toBe('inactive')

    act(() => {
      video.currentTime = 0.5
      fireEvent.timeUpdate(video)
    })
    expect(MockMediaRecorder.instances[0]?.state).toBe('recording')
    expect(screen.getByText('1')).toBeInTheDocument()
    act(() => {
      video.currentTime = 1
      fireEvent.timeUpdate(video)
    })
    expect(screen.getByText('ŞİMDİ KONUŞ')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Durdur/ })).not.toBeInTheDocument()

    act(() => {
      video.currentTime = 4.5
      fireEvent.timeUpdate(video)
    })
    expect(MockMediaRecorder.instances[0]?.state).toBe('recording')
    expect(screen.getByText('Cümleni bitir')).toBeInTheDocument()
    act(() => {
      video.currentTime = 5
      fireEvent.timeUpdate(video)
    })
    vi.useRealTimers()
    expect(await screen.findByRole('heading', { name: 'Kaydın hazır' })).toBeInTheDocument()
    expect(
      screen.getByText(/Doğal bitiriş payıyla kaydedilen çekim: 4.5 saniye/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dinle' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tekrar Kaydet' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Onayla' }))
    await waitFor(() => expect(screen.getByText('Replik 2 / 4')).toBeInTheDocument())
    expect(screen.getByText(/Kontrol ettim/)).toBeInTheDocument()
  })

  it('keeps the local take after upload failure and retries without recording again', async () => {
    vi.mocked(uploadLineRecording)
      .mockRejectedValueOnce(new Error('Ağ bağlantısı kesildi.'))
      .mockResolvedValueOnce({
        recordingId: '00000000-0000-4000-8000-000000000010',
        lineId: 'step-1',
        playerId,
        mimeType: 'audio/webm;codecs=opus',
        byteSize: 5,
        durationMs: 3500,
        uploadedAt: 1,
      })
    renderPlayback()
    await enterLineFlow()
    fireEvent.click(screen.getByRole('button', { name: 'İzlemeden geç' }))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Şimdi Seslendir' }))
    const video = document.querySelector('video')!
    await act(async () => vi.advanceTimersByTimeAsync(0))
    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(MockMediaRecorder.instances).toHaveLength(1)
    act(() => {
      video.currentTime = 0.5
      fireEvent.timeUpdate(video)
    })
    expect(MockMediaRecorder.instances[0]?.state).toBe('recording')
    act(() => {
      video.currentTime = 5
      fireEvent.timeUpdate(video)
    })
    vi.useRealTimers()
    await screen.findByRole('button', { name: 'Onayla' })
    fireEvent.click(screen.getByRole('button', { name: 'Onayla' }))
    expect(
      await screen.findByRole('button', { name: 'Yüklemeyi Yeniden Dene' }),
    ).toBeInTheDocument()
    expect(MockMediaRecorder.instances).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Yüklemeyi Yeniden Dene' }))
    await waitFor(() => expect(screen.getByText('Replik 2 / 4')).toBeInTheDocument())
    expect(uploadLineRecording).toHaveBeenCalledTimes(2)
  })

  it('restores a fully complete player directly to waiting and preserves host finalization', () => {
    const onFinalize = vi.fn()
    const recordings = ['step-1', 'step-3', 'step-4', 'step-6'].map((lineId, index) => ({
      recordingId: `00000000-0000-4000-8000-00000000001${index}`,
      lineId,
      playerId,
      mimeType: 'audio/webm;codecs=opus' as const,
      byteSize: 5,
      durationMs: 3500,
      uploadedAt: 1,
    }))
    renderPlayback(
      makeRoom(['nova', 'echo'], {
        recordings,
        recordingProgress: {
          totalRequired: 6,
          totalUploaded: 6,
          remaining: 0,
          readyForFinalization: true,
          players: [
            { playerId, required: 4, uploaded: 4, remaining: 0, complete: true, spectator: false },
            {
              playerId: otherId,
              required: 2,
              uploaded: 2,
              remaining: 0,
              complete: true,
              spectator: false,
            },
          ],
        },
      }),
      onFinalize,
    )
    expect(screen.getByRole('heading', { name: 'Tüm repliklerini tamamladın' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Son Hazırlığı Başlat' }))
    expect(onFinalize).toHaveBeenCalledOnce()
  })
})
