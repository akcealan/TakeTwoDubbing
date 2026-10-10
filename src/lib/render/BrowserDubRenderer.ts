import { recordingManifestSchema } from '../../../shared/schemas/recording'
import type { RecordingManifest } from '../../../shared/types'
import type { RoomSession } from '../../../shared/schemas/protocol'
import { ApiError, fetchFrozenRecording } from '../api/rooms'
import {
  backgroundExtension,
  buildCompositionPlan,
  recordingExtension,
  sourceExtension,
  type SourceProbe,
} from './compositionPlan'
import { createFfmpegWasmObjectUrl, ffmpegCoreJavascriptUrl } from './ffmpegRuntime'

export type RenderStage =
  'engine' | 'recordings' | 'audio-preparation' | 'audio-mix' | 'video' | 'complete'

export const renderStageLabels: Record<RenderStage, string> = {
  engine: 'Render motoru hazırlanıyor',
  recordings: 'Kayıtlar alınıyor',
  'audio-preparation': 'Sesler hazırlanıyor',
  'audio-mix': 'Dublaj birleştiriliyor',
  video: 'Video hazırlanıyor',
  complete: 'Tamamlandı',
}

export interface RenderDiagnostics {
  sourceDurationMs: number
  recordingInputCount: number
  outputBytes: number
  renderDurationMs: number
  sourceVideoMode: 'copy' | 'h264-transcode'
}

export interface RenderResult {
  blob: Blob
  diagnostics: RenderDiagnostics
}

interface InputBlob {
  name: string
  data: Blob
}

interface RenderEngine {
  load(signal: AbortSignal): Promise<void>
  createDir(path: string): Promise<void>
  mountInputs(path: string, inputs: InputBlob[]): Promise<void>
  unmount(path: string): Promise<void>
  deleteDir(path: string): Promise<void>
  exec(args: string[], signal: AbortSignal): Promise<number>
  readFile(path: string): Promise<Uint8Array | string>
  deleteFile(path: string): Promise<void>
  terminate(): void
}

export interface BrowserDubRendererDependencies {
  createEngine: () => Promise<RenderEngine>
  fetchRecording: typeof fetchFrozenRecording
  fetchMedia: (
    url: string,
    kind: 'source' | 'background',
    signal: AbortSignal,
    session?: RoomSession,
    manifest?: RecordingManifest,
  ) => Promise<Blob>
  now: () => number
}

export class DubRenderError extends Error {
  constructor(
    public readonly code:
      | 'BUSY'
      | 'MANIFEST_INVALID'
      | 'SOURCE_FAILED'
      | 'BACKGROUND_FAILED'
      | 'RECORDING_FAILED'
      | 'INPUT_UNSUPPORTED'
      | 'ENGINE_FAILED'
      | 'OUTPUT_FAILED'
      | 'CANCELLED',
    message: string,
  ) {
    super(message)
  }
}

async function createFfmpegEngine(): Promise<RenderEngine> {
  const { FFmpeg, FFFSType } = await import('@ffmpeg/ffmpeg')
  const ffmpeg = new FFmpeg()
  ffmpeg.on('log', ({ message }) => console.debug('[ffmpeg.wasm]', message))
  return {
    async load(signal) {
      if (ffmpeg.loaded) return
      const runtimeStartedAt = performance.now()
      const wasmURL = await createFfmpegWasmObjectUrl(signal)
      const reconstructedAt = performance.now()
      try {
        await ffmpeg.load(
          {
            coreURL: ffmpegCoreJavascriptUrl,
            wasmURL,
          },
          { signal },
        )
        console.info('Yerel ffmpeg runtime tanısı', {
          reconstructionDurationMs: Math.round(reconstructedAt - runtimeStartedAt),
          engineLoadDurationMs: Math.round(performance.now() - reconstructedAt),
          totalLoadDurationMs: Math.round(performance.now() - runtimeStartedAt),
        })
      } finally {
        URL.revokeObjectURL(wasmURL)
      }
    },
    async createDir(path) {
      await ffmpeg.createDir(path)
    },
    async mountInputs(path, inputs) {
      await ffmpeg.mount(FFFSType.WORKERFS, { blobs: inputs }, path)
    },
    async unmount(path) {
      await ffmpeg.unmount(path)
    },
    async deleteDir(path) {
      await ffmpeg.deleteDir(path)
    },
    async exec(args, signal) {
      return ffmpeg.exec(args, -1, { signal })
    },
    async readFile(path) {
      return ffmpeg.readFile(path)
    },
    async deleteFile(path) {
      await ffmpeg.deleteFile(path)
    },
    terminate() {
      ffmpeg.terminate()
    },
  }
}

async function fetchCanonicalMedia(
  url: string,
  kind: 'source' | 'background',
  signal: AbortSignal,
  session?: RoomSession,
  manifest?: RecordingManifest,
): Promise<Blob> {
  let response: Response
  try {
    const roomPrivateSource = /^\/api\/rooms\/\d{6}\/source-video$/.test(url)
    const roomPrivateBackground = /^\/api\/rooms\/\d{6}\/render-background$/.test(url)
    response = await fetch(new URL(url, window.location.origin), {
      signal,
      cache: 'no-store',
      headers:
        (roomPrivateSource || roomPrivateBackground) && session
          ? {
              Authorization: `Bearer ${session.token}`,
              'X-Room-Id': session.roomId,
              'X-Player-Id': session.playerId,
              ...(roomPrivateBackground && manifest
                ? { 'X-Manifest-Id': manifest.manifestId }
                : {}),
            }
          : undefined,
    })
  } catch {
    throw new DubRenderError(
      kind === 'source' ? 'SOURCE_FAILED' : 'BACKGROUND_FAILED',
      kind === 'source'
        ? 'Sahne videosu alınamadı. Bağlantını kontrol edip tekrar dene.'
        : 'Hazırlanmış arka plan sesi alınamadı. Bağlantını kontrol edip tekrar dene.',
    )
  }
  if (!response.ok)
    throw new DubRenderError(
      kind === 'source' ? 'SOURCE_FAILED' : 'BACKGROUND_FAILED',
      kind === 'source'
        ? 'Yetkili sahne videosu bulunamadı. Daha sonra tekrar dene.'
        : 'Hazırlanmış arka plan sesi bulunamadı. Daha sonra tekrar dene.',
    )
  const blob = await response.blob()
  if (!blob.size)
    throw new DubRenderError(
      kind === 'source' ? 'SOURCE_FAILED' : 'BACKGROUND_FAILED',
      kind === 'source' ? 'Sahne videosu boş geldi.' : 'Hazırlanmış arka plan sesi boş geldi.',
    )
  return blob
}

const defaultDependencies: BrowserDubRendererDependencies = {
  createEngine: createFfmpegEngine,
  fetchRecording: fetchFrozenRecording,
  fetchMedia: fetchCanonicalMedia,
  now: () => performance.now(),
}

export class BrowserDubRenderer {
  private engine: RenderEngine | null = null
  private running = false
  private controller: AbortController | null = null

  constructor(
    private readonly dependencies: BrowserDubRendererDependencies = defaultDependencies,
  ) {}

  get isRunning() {
    return this.running
  }

  async render(
    candidateManifest: RecordingManifest,
    session: RoomSession,
    onStage: (stage: RenderStage) => void,
    externalSignal?: AbortSignal,
  ): Promise<RenderResult> {
    if (this.running)
      throw new DubRenderError('BUSY', 'Aynı anda yalnızca bir video hazırlanabilir.')
    this.running = true
    this.controller = new AbortController()
    const signal = externalSignal
      ? AbortSignal.any([this.controller.signal, externalSignal])
      : this.controller.signal
    const startedAt = this.dependencies.now()
    let mounted = false
    const generatedFiles = ['/dub-mix.m4a', '/dubbed-scene.mp4']
    try {
      const parsedManifest = recordingManifestSchema.safeParse(candidateManifest)
      if (!parsedManifest.success || parsedManifest.data.roomId !== session.roomId)
        throw new DubRenderError(
          'MANIFEST_INVALID',
          'Dondurulmuş kayıt listesi doğrulanamadı. Odaya yeniden bağlanıp tekrar dene.',
        )
      const manifest = parsedManifest.data

      onStage('engine')
      if (!this.engine) this.engine = await this.dependencies.createEngine()
      if (!this.engine) throw new Error('Engine factory returned no engine')
      await this.engine.load(signal)

      onStage('recordings')
      const recordingBlobs = await Promise.all(
        manifest.entries.map((entry) =>
          this.dependencies.fetchRecording(session, manifest, entry, signal),
        ),
      )

      onStage('audio-preparation')
      const sourceBlob = await this.dependencies.fetchMedia(
        manifest.sourceVideoUrl,
        'source',
        signal,
        session,
        manifest,
      )
      const backgroundBlob = manifest.backgroundAudioUrl
        ? await this.dependencies.fetchMedia(
            manifest.backgroundAudioUrl,
            'background',
            signal,
            session,
            manifest,
          )
        : null
      const sourceInputExtension = sourceExtension(manifest.sourceVideoUrl, sourceBlob.type)
      const inputs: InputBlob[] = [
        {
          name: `source.${sourceInputExtension}`,
          data: sourceBlob,
        },
        ...(backgroundBlob && manifest.backgroundAudioUrl
          ? [
              {
                name: `background.${backgroundExtension(manifest.backgroundAudioUrl)}`,
                data: backgroundBlob,
              },
            ]
          : []),
        ...manifest.entries.map((entry, index) => ({
          name: `recording-${index}.${recordingExtension(entry.mimeType)}`,
          data: recordingBlobs[index]!,
        })),
      ]
      await this.engine.createDir('/inputs')
      await this.engine.mountInputs('/inputs', inputs)
      mounted = true

      // Studio accepts a source only after the browser has decoded its metadata. The private
      // room route deliberately has no extension, so the authoritative response MIME decides
      // whether the already-playable video can be stream-copied or needs WebM transcoding.
      const sourceProbe: SourceProbe = {
        codecName: sourceInputExtension === 'mp4' ? 'h264' : 'webm',
        pixelFormat: 'yuv420p',
        durationMs: manifest.sceneDurationMs,
      }
      const plan = buildCompositionPlan(manifest, sourceProbe, sourceInputExtension)

      onStage('audio-mix')
      const audioExitCode = await this.engine.exec(plan.audioMixCommand, signal)
      if (audioExitCode !== 0)
        throw new DubRenderError(
          'INPUT_UNSUPPORTED',
          'Seslerden biri bozuk veya render motorunca desteklenmiyor.',
        )

      onStage('video')
      const videoExitCode = await this.engine.exec(plan.videoCommand, signal)
      if (videoExitCode !== 0)
        throw new DubRenderError(
          'INPUT_UNSUPPORTED',
          'Sahne videosu bozuk veya final MP4 için desteklenmeyen bir codec içeriyor.',
        )
      const output = await this.engine.readFile(plan.outputPath)
      if (typeof output === 'string' || output.byteLength === 0)
        throw new DubRenderError('OUTPUT_FAILED', 'Render motoru geçerli bir MP4 üretemedi.')
      const bytes = new Uint8Array(output)
      const blob = new Blob([bytes], { type: 'video/mp4' })
      if (!blob.size) throw new DubRenderError('OUTPUT_FAILED', 'Render motoru boş bir MP4 üretti.')
      const diagnostics: RenderDiagnostics = {
        sourceDurationMs: sourceProbe.durationMs,
        recordingInputCount: manifest.entries.length,
        outputBytes: blob.size,
        renderDurationMs: Math.round(this.dependencies.now() - startedAt),
        sourceVideoMode: plan.copySourceVideo ? 'copy' : 'h264-transcode',
      }
      onStage('complete')
      console.info('Yerel render tanısı', diagnostics)
      return { blob, diagnostics }
    } catch (error) {
      if (signal.aborted)
        throw new DubRenderError(
          'CANCELLED',
          'Video hazırlama iptal edildi. Hazır olduğunda tekrar dene.',
        )
      if (error instanceof DubRenderError) throw error
      if (error instanceof ApiError) throw new DubRenderError('RECORDING_FAILED', error.message)
      if (error instanceof Error && error.message.includes('memory'))
        throw new DubRenderError(
          'ENGINE_FAILED',
          'Tarayıcı belleği bu sahneyi hazırlamaya yetmedi. Diğer sekmeleri kapatıp tekrar dene.',
        )
      console.error(
        '[dub-renderer] engine failure',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )
      throw new DubRenderError(
        'ENGINE_FAILED',
        'Render motoru başlatılamadı veya beklenmeyen bir hata oluştu. Tekrar dene.',
      )
    } finally {
      if (this.engine) {
        for (const path of generatedFiles)
          try {
            await this.engine.deleteFile(path)
          } catch {
            // A failed stage may not have created every output.
          }
        if (mounted)
          try {
            await this.engine.unmount('/inputs')
            await this.engine.deleteDir('/inputs')
          } catch {
            // Termination below resets an engine with a damaged virtual filesystem.
          }
      }
      if (signal.aborted) this.resetEngine()
      this.running = false
      this.controller = null
    }
  }

  cancel() {
    this.controller?.abort()
    this.resetEngine()
  }

  dispose() {
    this.controller?.abort()
    this.resetEngine()
  }

  private resetEngine() {
    this.engine?.terminate()
    this.engine = null
  }
}
