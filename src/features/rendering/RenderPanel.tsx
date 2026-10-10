import { useEffect, useRef, useState } from 'react'
import type { RoomSession } from '../../../shared/schemas/protocol'
import type { RecordingManifest, Scene } from '../../../shared/types'
import {
  BrowserDubRenderer,
  DubRenderError,
  renderStageLabels,
  type RenderDiagnostics,
  type RenderStage,
} from '../../lib/render/BrowserDubRenderer'
import { safeRenderFilename } from './filename'
import { uploadFinalResult } from '../../lib/api/rooms'

interface RendererLike {
  render(
    manifest: RecordingManifest,
    session: RoomSession,
    onStage: (stage: RenderStage) => void,
  ): Promise<{ blob: Blob; diagnostics: RenderDiagnostics }>
  cancel(): void
  dispose(): void
}

interface RenderPanelProps {
  manifest: RecordingManifest
  session: RoomSession
  scene: Scene
  createRenderer?: () => RendererLike
}

type RenderState =
  | { phase: 'idle' }
  | { phase: 'running'; stage: RenderStage }
  | { phase: 'error'; message: string }
  | {
      phase: 'success' | 'uploading' | 'upload-error'
      url: string
      blob: Blob
      resultId: string
      diagnostics: RenderDiagnostics
      message?: string
    }

export function RenderPanel({
  manifest,
  session,
  scene,
  createRenderer = () => new BrowserDubRenderer(),
}: RenderPanelProps) {
  const renderer = useRef<RendererLike | null>(null)
  const currentUrl = useRef<string | null>(null)
  const [state, setState] = useState<RenderState>({ phase: 'idle' })

  useEffect(
    () => () => {
      renderer.current?.dispose()
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    },
    [],
  )

  const start = async () => {
    if (state.phase === 'running') return
    if (!renderer.current) renderer.current = createRenderer()
    setState({ phase: 'running', stage: 'engine' })
    try {
      const result = await renderer.current.render(manifest, session, (stage) =>
        setState({ phase: 'running', stage }),
      )
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
      const url = URL.createObjectURL(result.blob)
      currentUrl.current = url
      const resultId = crypto.randomUUID()
      const rendered = { url, blob: result.blob, resultId, diagnostics: result.diagnostics }
      setState({ phase: 'uploading', ...rendered })
      try {
        await uploadFinalResult(session, manifest, resultId, result.blob)
        setState({ phase: 'success', ...rendered })
      } catch (error) {
        setState({
          phase: 'upload-error',
          ...rendered,
          message: error instanceof Error ? error.message : 'Final video yüklenemedi.',
        })
      }
    } catch (error) {
      setState({
        phase: 'error',
        message:
          error instanceof DubRenderError
            ? error.message
            : 'Video hazırlanırken beklenmeyen bir sorun oluştu. Tekrar dene.',
      })
    }
  }

  const retryUpload = async () => {
    if (state.phase !== 'upload-error') return
    const retained = state
    setState({ ...retained, phase: 'uploading', message: undefined })
    try {
      await uploadFinalResult(session, manifest, retained.resultId, retained.blob)
      setState({ ...retained, phase: 'success', message: undefined })
    } catch (error) {
      setState({
        ...retained,
        phase: 'upload-error',
        message: error instanceof Error ? error.message : 'Final video yüklenemedi.',
      })
    }
  }

  return (
    <section className="render-panel" aria-labelledby="render-panel-title">
      <span className="eyebrow">Odanın final videosu</span>
      <h2 id="render-panel-title">Dublaj videosunu hazırla</h2>
      <p>
        Dondurulmuş listedeki {manifest.entries.length} kayıt
        {manifest.backgroundAudioUrl ? ' ve konuşmasız arka plan' : ''}, doğrulanmış zamanlarına
        göre bu tarayıcıda birleştirilecek ve ardından odanın özel geçici deposuna yüklenecek.
      </p>

      {state.phase === 'idle' && (
        <button type="button" className="button button-primary" onClick={() => void start()}>
          Yerel MP4'ü Hazırla
        </button>
      )}

      {state.phase === 'running' && (
        <div className="render-running" role="status" aria-live="polite">
          <span className="render-spinner" aria-hidden="true" />
          <div>
            <strong>{renderStageLabels[state.stage]}</strong>
            <small>
              Kısa sahneler bile cihazın hızına göre birkaç dakika sürebilir. Bu sekmeyi açık tut.
            </small>
          </div>
          <button type="button" className="text-button" onClick={() => renderer.current?.cancel()}>
            İptal Et
          </button>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="render-error" role="alert">
          <strong>Video hazırlanamadı.</strong>
          <span>{state.message}</span>
          <button type="button" className="button button-secondary" onClick={() => void start()}>
            Yeniden Dene
          </button>
        </div>
      )}

      {(state.phase === 'success' ||
        state.phase === 'uploading' ||
        state.phase === 'upload-error') && (
        <div className="render-result">
          <div className="render-success" role="status">
            <strong>
              {state.phase === 'uploading'
                ? 'Video yükleniyor'
                : state.phase === 'upload-error'
                  ? 'Yükleme tamamlanamadı'
                  : 'Paylaşılan sonuç hazır'}
            </strong>
            <span>
              {state.phase === 'uploading'
                ? 'Yerel video korunuyor; oda sonucu kalıcılaştırılıyor.'
                : state.phase === 'upload-error'
                  ? state.message
                  : 'Odadaki herkes bu videoya güvenli biçimde erişebilir.'}
            </span>
          </div>
          <video src={state.url} controls playsInline preload="metadata">
            Tarayıcın sonuç videosunu oynatmayı desteklemiyor.
          </video>
          <div className="render-actions">
            <a
              className="button button-primary"
              href={state.url}
              download={safeRenderFilename(scene.title, session.code)}
            >
              Yerel MP4'ü İndir
            </a>
            {state.phase === 'upload-error' && (
              <button
                type="button"
                className="button button-primary"
                onClick={() => void retryUpload()}
              >
                Yüklemeyi Yeniden Dene
              </button>
            )}
            <button type="button" className="button button-secondary" onClick={() => void start()}>
              Yeniden Hazırla
            </button>
          </div>
          <dl className="render-diagnostics" aria-label="Yerel render bilgileri">
            <div>
              <dt>Kaynak süresi</dt>
              <dd>{(state.diagnostics.sourceDurationMs / 1000).toFixed(1)} sn</dd>
            </div>
            <div>
              <dt>Kayıt girdisi</dt>
              <dd>{state.diagnostics.recordingInputCount}</dd>
            </div>
            <div>
              <dt>MP4 boyutu</dt>
              <dd>{Math.ceil(state.diagnostics.outputBytes / 1024)} KB</dd>
            </div>
            <div>
              <dt>Yerel işlem süresi</dt>
              <dd>{(state.diagnostics.renderDurationMs / 1000).toFixed(1)} sn</dd>
            </div>
          </dl>
        </div>
      )}

      <small className="render-manifest-id">Manifest kimliği: {manifest.manifestId}</small>
    </section>
  )
}
