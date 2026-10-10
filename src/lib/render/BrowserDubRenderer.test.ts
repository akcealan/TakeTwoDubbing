import { describe, expect, it, vi } from 'vitest'
import { recordingManifestSchema } from '../../../shared/schemas/recording'
import type { RoomSession } from '../../../shared/schemas/protocol'
import type { RecordingManifest, StoredRecording } from '../../../shared/types'
import { BrowserDubRenderer, DubRenderError } from './BrowserDubRenderer'

const session: RoomSession = {
  code: '012345',
  roomId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002',
  token: 'a'.repeat(64),
}
const manifest = recordingManifestSchema.parse({
  version: 1,
  manifestId: '00000000-0000-4000-8000-000000000010',
  roomId: session.roomId,
  sceneId: 'a-small-step',
  sourceVideoUrl: '/scenes/a-small-step/video.webm',
  sceneDurationMs: 30_000,
  createdAt: 1,
  entries: [
    {
      lineId: 'step-1',
      characterId: 'nova',
      playerId: session.playerId,
      startMs: 1_000,
      endMs: 4_500,
      recordingId: '00000000-0000-4000-8000-000000000100',
      mimeType: 'audio/webm;codecs=opus',
      byteSize: 4,
      durationMs: 1_000,
    },
  ],
})
const manifestWithBackground = recordingManifestSchema.parse({
  ...manifest,
  backgroundAudioUrl: `/api/rooms/${session.code}/render-background`,
})

function harness(options: { firstExecFails?: boolean; secondExecFails?: boolean } = {}) {
  let execCalls = 0
  const engine = {
    load: vi.fn(async (signal: AbortSignal): Promise<void> => {
      void signal
    }),
    createDir: vi.fn(async () => undefined),
    mountInputs: vi.fn(async () => undefined),
    unmount: vi.fn(async () => undefined),
    deleteDir: vi.fn(async () => undefined),
    exec: vi.fn(async (_args: string[]) => {
      void _args
      execCalls += 1
      if (options.firstExecFails && execCalls === 1) return 1
      if (options.secondExecFails && execCalls === 2) return 1
      return 0
    }),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5])),
    deleteFile: vi.fn(async () => undefined),
    terminate: vi.fn(),
  }
  const fetchRecording = vi.fn(
    async (
      _session: RoomSession,
      _manifest: RecordingManifest,
      _recording: Pick<StoredRecording, 'recordingId' | 'mimeType' | 'byteSize'>,
      _signal?: AbortSignal,
    ) => {
      void _session
      void _manifest
      void _recording
      void _signal
      return new Blob([new Uint8Array(4)])
    },
  )
  const fetchMedia = vi.fn(
    async (
      _url: string,
      _kind: 'source' | 'background',
      _signal: AbortSignal,
      _session?: RoomSession,
      _manifest?: RecordingManifest,
    ) => {
      void _signal
      void _session
      void _manifest
      return new Blob([new Uint8Array([1, 2, 3])], {
        type: _kind === 'source' ? 'video/webm' : 'audio/mp4',
      })
    },
  )
  let now = 100
  const renderer = new BrowserDubRenderer({
    createEngine: vi.fn(async () => engine),
    fetchRecording,
    fetchMedia,
    now: () => (now += 50),
  })
  return { renderer, engine, fetchRecording, fetchMedia }
}

describe('browser dub renderer', () => {
  it('fetches recording input only from the validated frozen manifest', async () => {
    const { renderer, fetchRecording } = harness()
    const result = await renderer.render(manifest, session, vi.fn())
    expect(result.blob.type).toBe('video/mp4')
    expect(fetchRecording).toHaveBeenCalledOnce()
    expect(fetchRecording.mock.calls[0]?.[2]).toMatchObject({
      recordingId: manifest.entries[0]?.recordingId,
    })
  })

  it('fails truthfully for an unsupported or corrupt source', async () => {
    const { renderer } = harness({ secondExecFails: true })
    await expect(renderer.render(manifest, session, vi.fn())).rejects.toMatchObject({
      code: 'INPUT_UNSUPPORTED',
    })
  })

  it('fetches the frozen room background with manifest context and never substitutes source audio', async () => {
    const { renderer, fetchMedia, engine } = harness()
    await renderer.render(manifestWithBackground, session, vi.fn())
    expect(fetchMedia).toHaveBeenNthCalledWith(
      2,
      manifestWithBackground.backgroundAudioUrl,
      'background',
      expect.any(AbortSignal),
      session,
      manifestWithBackground,
    )
    const audioCommand = engine.exec.mock.calls[0]?.[0] as string[]
    expect(audioCommand).toContain('/inputs/background.m4a')
    expect(audioCommand).not.toContain('/inputs/source.webm')
  })

  it('fails visibly when a frozen background cannot be fetched', async () => {
    const { renderer, fetchMedia } = harness()
    fetchMedia.mockImplementation(async (_url, kind) => {
      if (kind === 'background')
        throw new DubRenderError('BACKGROUND_FAILED', 'Hazırlanmış arka plan alınamadı.')
      return new Blob([new Uint8Array([1, 2, 3])])
    })
    await expect(renderer.render(manifestWithBackground, session, vi.fn())).rejects.toMatchObject({
      code: 'BACKGROUND_FAILED',
    })
  })

  it('mounts a private extensionless source using its authoritative MP4 response MIME type', async () => {
    const privateManifest = recordingManifestSchema.parse({
      ...manifest,
      sourceVideoUrl: `/api/rooms/${session.code}/source-video`,
    })
    const { renderer, fetchMedia, engine } = harness()
    fetchMedia.mockImplementation(
      async (_url, kind) =>
        new Blob([new Uint8Array([1, 2, 3])], {
          type: kind === 'source' ? 'video/mp4' : 'audio/mp4',
        }),
    )
    await renderer.render(privateManifest, session, vi.fn())
    expect(engine.mountInputs).toHaveBeenCalledWith(
      '/inputs',
      expect.arrayContaining([expect.objectContaining({ name: 'source.mp4' })]),
    )
    const videoCommand = engine.exec.mock.calls[1]?.[0] as string[]
    expect(videoCommand).toContain('/inputs/source.mp4')
  })

  it('can retry after an ffmpeg input failure', async () => {
    const { renderer, engine } = harness({ firstExecFails: true })
    await expect(renderer.render(manifest, session, vi.fn())).rejects.toMatchObject({
      code: 'INPUT_UNSUPPORTED',
    })
    const result = await renderer.render(manifest, session, vi.fn())
    expect(result.blob.size).toBeGreaterThan(0)
    expect(engine.exec).toHaveBeenCalledTimes(3)
  })

  it('prevents duplicate concurrent renders', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const { renderer, engine } = harness()
    engine.load.mockImplementationOnce(async () => pending)
    const first = renderer.render(manifest, session, vi.fn())
    await expect(renderer.render(manifest, session, vi.fn())).rejects.toEqual(
      expect.objectContaining({ code: 'BUSY' } satisfies Partial<DubRenderError>),
    )
    release?.()
    await first
  })

  it('surfaces runtime loading failures as retryable engine UX', async () => {
    const { renderer, engine } = harness()
    engine.load.mockRejectedValueOnce(new Error('Runtime part integrity mismatch'))
    await expect(renderer.render(manifest, session, vi.fn())).rejects.toMatchObject({
      code: 'ENGINE_FAILED',
      message: expect.stringContaining('Render motoru'),
    })
    await expect(renderer.render(manifest, session, vi.fn())).resolves.toMatchObject({
      blob: expect.any(Blob),
    })
  })

  it('surfaces a missing private recording and keeps retry possible', async () => {
    const { renderer, fetchRecording } = harness()
    fetchRecording.mockRejectedValueOnce(
      new DubRenderError('RECORDING_FAILED', 'Dondurulmuş kayıt bulunamadı.'),
    )
    await expect(renderer.render(manifest, session, vi.fn())).rejects.toMatchObject({
      code: 'RECORDING_FAILED',
    })
    await expect(renderer.render(manifest, session, vi.fn())).resolves.toMatchObject({
      blob: expect.any(Blob),
    })
  })
})
