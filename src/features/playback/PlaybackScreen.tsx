import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { DialogueLine, Room, Scene } from '../../../shared/types'
import type { RoomSession } from '../../../shared/schemas/protocol'
import { resolveRoomScene } from '../../../shared/scenes/catalog'
import { fetchRoomSceneSource } from '../../lib/api/studio'
import { formatTimestamp } from '../../lib/time'
import {
  getGuidedAttemptPlan,
  getGuidedLineTiming,
  getOrderedOwnedLines,
  getPreRollStartMs,
  getPreparationElapsedMs,
} from '../../lib/playback/guidedTiming'
import { normalizePlaybackTime } from '../../lib/playback/timing'
import type { ConnectionSnapshot } from '../../lib/websocket/RoomConnection'
import { useGuidedLineRecorder } from '../../hooks/useGuidedLineRecorder'
import { useMicrophoneTest } from '../../hooks/useMicrophoneTest'
import { useRecordingUploads } from '../../hooks/useRecordingUploads'
import type { LocalLineRecording } from '../../lib/recording/localRecording'
import { RenderPanel } from '../rendering/RenderPanel'

interface PlaybackScreenProps {
  room: Room
  session: RoomSession
  connectionStatus: ConnectionSnapshot['status']
  connectionError: string | null
  saved: boolean
  onLeave: () => void
  onReconnect: () => void
  onFinalize: () => void
}

type GuidedStage =
  | 'scene-preview'
  | 'microphone-test'
  | 'line-preparation'
  | 'context-preview'
  | 'attempt'
  | 'take-review'
  | 'saving'
  | 'complete'
  | 'spectator'

export function PlaybackScreen(props: PlaybackScreenProps) {
  const source = usePrivateRoomSource(props.room, props.session)
  const baseScene = resolveRoomScene(props.room)
  const scene = useMemo(
    () =>
      baseScene && baseScene.origin.kind === 'private'
        ? source.url
          ? { ...baseScene, videoUrl: source.url }
          : undefined
        : baseScene,
    [baseScene, source.url],
  )
  const me = props.room.players.find((player) => player.id === props.session.playerId)
  const ownedIds = useMemo(() => new Set(me?.characterIds ?? []), [me?.characterIds])
  const ownedLines = useMemo(
    () => (scene ? getOrderedOwnedLines(scene.lines, ownedIds) : []),
    [ownedIds, scene],
  )
  const storedCompletedIds = useMemo(
    () =>
      new Set(
        (props.room.recordings ?? [])
          .filter((recording) => recording.playerId === props.session.playerId)
          .map((recording) => recording.lineId),
      ),
    [props.room.recordings, props.session.playerId],
  )

  if (!scene)
    return (
      <section className="empty-page">
        <h1>{source.loading ? 'Özel sahne videosu yükleniyor…' : 'Sahne bulunamadı.'}</h1>
        <p role="alert">
          {source.error ??
            (source.loading
              ? 'Oda için korunan medya kopyası hazırlanıyor.'
              : 'Bu odanın sahne bilgisi kullanılamıyor.')}
        </p>
      </section>
    )

  if (props.room.status === 'processing')
    return (
      <ProcessingExperience
        room={props.room}
        session={props.session}
        scene={scene}
        connectionStatus={props.connectionStatus}
      />
    )

  return (
    <GuidedPlayingExperience
      {...props}
      scene={scene}
      ownedLines={ownedLines}
      storedCompletedIds={storedCompletedIds}
    />
  )
}

function usePrivateRoomSource(room: Room, session: RoomSession) {
  const isPrivate = resolveRoomScene(room)?.origin.kind === 'private'
  const [state, setState] = useState<{
    url: string | null
    loading: boolean
    error: string | null
  }>({ url: null, loading: isPrivate, error: null })
  useEffect(() => {
    if (!isPrivate) return
    const controller = new AbortController()
    let url: string | null = null
    void fetchRoomSceneSource(session, controller.signal)
      .then((blob) => {
        url = URL.createObjectURL(blob)
        setState({ url, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            url: null,
            loading: false,
            error: error instanceof Error ? error.message : 'Özel sahne videosu alınamadı.',
          })
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [isPrivate, session])
  return state
}

function GuidedPlayingExperience({
  room,
  session,
  scene,
  ownedLines,
  storedCompletedIds,
  connectionStatus,
  connectionError,
  saved,
  onLeave,
  onReconnect,
  onFinalize,
}: PlaybackScreenProps & {
  scene: Scene
  ownedLines: DialogueLine[]
  storedCompletedIds: ReadonlySet<string>
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [stage, setStage] = useState<GuidedStage>(() =>
    ownedLines.length > 0 && ownedLines.every((line) => storedCompletedIds.has(line.id))
      ? 'complete'
      : 'scene-preview',
  )
  const [currentMs, setCurrentMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [contextDone, setContextDone] = useState(false)
  const [preparationElapsedMs, setPreparationElapsedMs] = useState(0)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [acknowledgedIds, setAcknowledgedIds] = useState<ReadonlySet<string>>(() => new Set())
  const microphone = useMicrophoneTest()
  const recorder = useGuidedLineRecorder(session.playerId, ownedLines, scene.durationMs)
  const { abort: abortRecording, beginAtCaptureStart } = recorder
  const uploads = useRecordingUploads(session)
  const completedIds = useMemo(
    () => new Set([...storedCompletedIds, ...acknowledgedIds]),
    [acknowledgedIds, storedCompletedIds],
  )
  const currentLine = ownedLines.find((line) => !completedIds.has(line.id)) ?? null
  const currentLineNumber = currentLine
    ? ownedLines.findIndex((line) => line.id === currentLine.id) + 1
    : ownedLines.length
  const attemptPlan = useMemo(
    () => (currentLine ? getGuidedAttemptPlan(currentLine, scene.durationMs) : null),
    [currentLine, scene.durationMs],
  )
  const timing = currentLine
    ? getGuidedLineTiming(currentLine, currentMs, {
        sceneDurationMs: scene.durationMs,
        preparationElapsedMs,
      })
    : null
  const online = connectionStatus === 'connected'

  const syncClock = useCallback(() => {
    if (videoRef.current)
      setCurrentMs(normalizePlaybackTime(videoRef.current.currentTime * 1_000, scene.durationMs))
  }, [scene.durationMs])

  useEffect(() => {
    if (!playing) return
    let frame = requestAnimationFrame(function update() {
      syncClock()
      frame = requestAnimationFrame(update)
    })
    return () => cancelAnimationFrame(frame)
  }, [playing, syncClock])

  useEffect(() => {
    if (stage === 'context-preview' && currentLine && currentMs >= currentLine.endMs) {
      videoRef.current?.pause()
      setContextDone(true)
      setStage('line-preparation')
    }
  }, [currentLine, currentMs, stage])

  useEffect(() => {
    if (stage !== 'attempt' || !currentLine) return
    const plan = getGuidedAttemptPlan(currentLine, scene.durationMs)
    if (preparationElapsedMs < plan.preparationHoldMs) return
    if (
      currentMs >= plan.captureStartMs &&
      currentMs < plan.captureEndMs &&
      recorder.phase === 'armed'
    )
      recorder.beginAtCaptureStart(currentLine)
    if (currentMs >= plan.captureEndMs && recorder.phase === 'recording') {
      recorder.stopAtCaptureEnd(currentLine)
      videoRef.current?.pause()
    }
  }, [currentLine, currentMs, preparationElapsedMs, recorder, scene.durationMs, stage])

  useEffect(() => {
    if (stage !== 'attempt' || !currentLine || !attemptPlan?.preparationHoldMs) return
    const startedAtMs = performance.now()
    const interval = window.setInterval(() => {
      const elapsedMs = getPreparationElapsedMs(
        startedAtMs,
        performance.now(),
        attemptPlan.preparationHoldMs,
      )
      setPreparationElapsedMs(elapsedMs)
      if (elapsedMs < attemptPlan.preparationHoldMs) return
      window.clearInterval(interval)
      if (attemptPlan.captureStartMs <= attemptPlan.preRollStartMs) beginAtCaptureStart(currentLine)
      const video = videoRef.current
      if (!video) return
      void video.play().catch(() => {
        abortRecording()
        setStage('line-preparation')
        setMediaError('Seslendirme oynatması başlatılamadı. Tekrar deneyebilirsin.')
      })
    }, 50)
    return () => window.clearInterval(interval)
  }, [abortRecording, attemptPlan, beginAtCaptureStart, currentLine, stage])

  useEffect(() => {
    if (stage === 'attempt' && recorder.phase === 'preview') {
      videoRef.current?.pause()
      setStage('take-review')
    }
  }, [recorder.phase, stage])

  useEffect(() => {
    if (
      !['scene-preview', 'microphone-test', 'spectator'].includes(stage) &&
      ownedLines.length > 0 &&
      !currentLine
    )
      setStage('complete')
  }, [currentLine, ownedLines.length, stage])

  const seek = (milliseconds: number) => {
    const next = normalizePlaybackTime(milliseconds, scene.durationMs)
    if (videoRef.current) videoRef.current.currentTime = next / 1_000
    setCurrentMs(next)
  }

  const playContext = async () => {
    if (!currentLine || !videoRef.current) return
    const video = videoRef.current
    setMediaError(null)
    setContextDone(false)
    setStage('context-preview')
    video.muted = false
    try {
      await waitForMediaMetadata(video)
      seek(getPreRollStartMs(currentLine))
      await waitForMediaSeek(video)
      await video.play()
    } catch {
      setStage('line-preparation')
      setMediaError('Sahne bağlamı oynatılamadı. Tarayıcı ayarlarını kontrol edip tekrar dene.')
    }
  }

  const startAttempt = async () => {
    if (!currentLine || !videoRef.current) return
    const video = videoRef.current
    setMediaError(null)
    if (!(await recorder.prepare(currentLine))) return
    video.pause()
    video.muted = true
    try {
      await waitForMediaMetadata(video)
      const plan = getGuidedAttemptPlan(currentLine, scene.durationMs)
      seek(plan.preRollStartMs)
      await waitForMediaSeek(video)
      setPreparationElapsedMs(0)
      setStage('attempt')
      if (plan.preparationHoldMs === 0) await video.play()
    } catch {
      recorder.abort()
      setStage('line-preparation')
      setMediaError('Seslendirme oynatması başlatılamadı. Tekrar deneyebilirsin.')
    }
  }

  const listenToTake = async () => {
    try {
      if (!audioRef.current) throw new Error('missing audio')
      audioRef.current.currentTime = 0
      await audioRef.current.play()
    } catch {
      setMediaError('Kayıt önizlemesi oynatılamadı. Yeniden kaydetmeyi deneyebilirsin.')
    }
  }

  const confirmTake = async () => {
    if (!recorder.draft || !currentLine) return
    const recording = recorder.draft
    setStage('saving')
    if (!(await uploads.upload(recording))) {
      setStage('take-review')
      return
    }
    setAcknowledgedIds((current) => new Set(current).add(recording.lineId))
    recorder.discardDraft()
    const hasAnother = ownedLines.some(
      (line) => line.id !== recording.lineId && !completedIds.has(line.id),
    )
    setContextDone(false)
    seek(0)
    setStage(hasAnother ? 'line-preparation' : 'complete')
  }

  const finishPreview = () => {
    videoRef.current?.pause()
    seek(0)
    setStage(ownedLines.length === 0 ? 'spectator' : 'microphone-test')
  }

  return (
    <section className="playback-page guided-page">
      <GuidedHeader
        room={room}
        sceneTitle={scene.title}
        connectionStatus={connectionStatus}
        connectionError={connectionError}
        saved={saved}
        onReconnect={onReconnect}
      />
      <div className="guided-grid">
        <main className="guided-main">
          <section className="guided-card" aria-live="polite">
            {stage === 'scene-preview' && (
              <ScenePreview
                scene={scene}
                assignedNames={(
                  room.players.find((player) => player.id === session.playerId)?.characterIds ?? []
                )
                  .map((id) => scene.characters.find((character) => character.id === id)?.name)
                  .filter((name): name is string => Boolean(name))}
                onFinish={finishPreview}
              />
            )}
            {stage === 'microphone-test' && (
              <MicrophoneTestScreen
                microphone={microphone}
                onContinue={() => {
                  microphone.stop()
                  setStage('line-preparation')
                }}
              />
            )}
            {(stage === 'line-preparation' || stage === 'context-preview') && currentLine && (
              <LinePreparation
                scene={scene}
                line={currentLine}
                characterName={characterName(scene, currentLine)}
                lineNumber={currentLineNumber}
                total={ownedLines.length}
                completed={completedIds.size}
                contextPlaying={stage === 'context-preview'}
                contextDone={contextDone}
                onContext={playContext}
                onSkip={() => setContextDone(true)}
                onAttempt={startAttempt}
              />
            )}
            {stage === 'attempt' && currentLine && timing && (
              <DubbingAttempt
                line={currentLine}
                characterName={characterName(scene, currentLine)}
                timing={timing}
                recorderPhase={recorder.phase}
              />
            )}
            {['scene-preview', 'line-preparation', 'context-preview', 'attempt'].includes(
              stage,
            ) && (
              <GuidedVideo
                scene={scene}
                videoRef={videoRef}
                controls={stage === 'scene-preview'}
                muted={stage === 'attempt'}
                onClock={syncClock}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setMediaError('Sahne videosu yüklenemedi.')}
              />
            )}
            {(stage === 'take-review' || stage === 'saving') && currentLine && recorder.draft && (
              <TakeReview
                line={currentLine}
                characterName={characterName(scene, currentLine)}
                draft={recorder.draft}
                saving={stage === 'saving'}
                uploadError={uploads.states.get(currentLine.id)?.error ?? null}
                audioRef={audioRef}
                onListen={listenToTake}
                onRetry={() => {
                  recorder.discardDraft()
                  setContextDone(false)
                  setStage('line-preparation')
                }}
                onConfirm={confirmTake}
              />
            )}
            {stage === 'complete' && (
              <CompletionState room={room} playerId={session.playerId} onFinalize={onFinalize} />
            )}
            {stage === 'spectator' && (
              <section className="guided-step guided-centered">
                <span className="eyebrow">Seyirci modu</span>
                <h2>Bu turda seslendireceğin bir karakter yok.</h2>
                <p>
                  Kayıt ekranına girmeden arkadaşlarının ilerlemesini buradan takip edebilirsin.
                </p>
              </section>
            )}
            {recorder.error && (
              <p className="recording-error" role="alert">
                {recorder.error}
              </p>
            )}
            {mediaError && (
              <p className="recording-error" role="alert">
                {mediaError}
              </p>
            )}
          </section>
        </main>
        <aside className="guided-sidebar">
          <PlayerProgress room={room} playerId={session.playerId} />
          <section className="guided-side-card">
            <span className="eyebrow">Gizli kayıtlar</span>
            <p>Diğer oyuncuların kayıtları final videoya kadar gizli.</p>
          </section>
          <button className="text-button leave-button" disabled={!online} onClick={onLeave}>
            Odadan ayrıl
          </button>
        </aside>
      </div>
    </section>
  )
}

function GuidedHeader({
  room,
  sceneTitle,
  connectionStatus,
  connectionError,
  saved,
  onReconnect,
}: {
  room: Room
  sceneTitle: string
  connectionStatus: ConnectionSnapshot['status']
  connectionError: string | null
  saved: boolean
  onReconnect: () => void
}) {
  const online = connectionStatus === 'connected'
  return (
    <>
      <header className="playback-heading">
        <div>
          <span className="eyebrow">Rehberli seslendirme · Oda {room.code}</span>
          <h1>{sceneTitle}</h1>
          <p>Her replik kanonik yerine hizalanır; doğal başlayıp bitirmen için kısa pay tanınır.</p>
        </div>
        <span role="status" className={`connection-badge ${online ? 'is-online' : ''}`}>
          <span />
          {online
            ? 'Bağlı'
            : connectionStatus === 'reconnecting'
              ? 'Yeniden bağlanıyor…'
              : 'Bağlantı kesildi'}
        </span>
      </header>
      {connectionError && (
        <div role="alert" className="room-error">
          {connectionError}
          {!online && (
            <button className="text-button" onClick={onReconnect}>
              Yeniden bağlan
            </button>
          )}
        </div>
      )}
      {!saved && (
        <p role="status" className="room-error">
          Tarayıcı oturumunu kaydedemiyor. Sayfayı yenilersen kimliğini kaybedebilirsin.
        </p>
      )}
    </>
  )
}

interface VideoEvents {
  videoRef: RefObject<HTMLVideoElement | null>
  onClock: () => void
  onPlay: () => void
  onPause: () => void
}

function ScenePreview({
  scene,
  assignedNames,
  onFinish,
}: {
  scene: Scene
  assignedNames: string[]
  onFinish: () => void
}) {
  return (
    <section className="guided-step">
      <span className="eyebrow">1 · Önce sahneyi tanı</span>
      <h2>Sahneyi özgün hâliyle izle</h2>
      <p>Seslendirmeye başlamadan önce ritmi, tepkileri ve karakterlerin konuşma biçimini izle.</p>
      <p className="assignment-copy">
        {assignedNames.length ? 'Karakterlerin:' : 'Bu turu seyirci olarak izleyeceksin.'}
      </p>
      {assignedNames.length > 0 && (
        <ul className="assigned-character-list" aria-label="Atanan karakterlerin">
          {assignedNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      <p className="truth-note">
        {scene.sourceAudioStatus === 'present'
          ? 'Bu ön izlemede sahnenin özgün sesi açıktır.'
          : scene.sourceAudioStatus === 'silent'
            ? 'Bu geliştirme videosu sessizdir; olmayan bir kaynak sesi varmış gibi gösterilmez.'
            : 'Kaynak ses durumu doğrulanmadı; oynatıcı mevcut medya sesini değiştirmeden kullanır.'}
      </p>
      <button type="button" className="button button-primary" onClick={onFinish}>
        Sahneyi İzlemeyi Bitir
      </button>
    </section>
  )
}

function MicrophoneTestScreen({
  microphone,
  onContinue,
}: {
  microphone: ReturnType<typeof useMicrophoneTest>
  onContinue: () => void
}) {
  return (
    <section className="guided-step guided-centered">
      <span className="eyebrow">2 · Mikrofon kontrolü</span>
      <h2>Sesini birlikte kontrol edelim</h2>
      <p>Bu test yalnızca canlı seviyeyi gösterir; sesin kaydedilmez veya yüklenmez.</p>
      <div
        className="microphone-meter"
        role="meter"
        aria-label="Mikrofon ses seviyesi"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(microphone.level * 100)}
      >
        <span style={{ width: `${microphone.level * 100}%` }} />
      </div>
      <strong className="microphone-message" role="status">
        {microphone.message}
      </strong>
      {microphone.error && (
        <p className="recording-error" role="alert">
          {microphone.error}
        </p>
      )}
      <div className="guided-actions">
        {!microphone.ready && (
          <button
            type="button"
            className="button button-secondary"
            disabled={microphone.phase === 'requesting'}
            onClick={() => void microphone.start()}
          >
            {microphone.phase === 'requesting' ? 'Mikrofon bekleniyor…' : 'Mikrofonu Dene'}
          </button>
        )}
        {microphone.ready && (
          <button type="button" className="button button-primary" onClick={onContinue}>
            Kayda Hazırım
          </button>
        )}
      </div>
    </section>
  )
}

function LinePreparation({
  scene,
  line,
  characterName: name,
  lineNumber,
  total,
  completed,
  contextPlaying,
  contextDone,
  onContext,
  onSkip,
  onAttempt,
}: {
  scene: Scene
  line: DialogueLine
  characterName: string
  lineNumber: number
  total: number
  completed: number
  contextPlaying: boolean
  contextDone: boolean
  onContext: () => void
  onSkip: () => void
  onAttempt: () => void
}) {
  return (
    <section className="guided-step">
      <span className="eyebrow">3 · Sıradaki görevin</span>
      <div className="line-counter">
        <strong>
          Replik {lineNumber} / {total}
        </strong>
        <span>
          {completed} tamamlandı · {total - completed} kaldı
        </span>
      </div>
      <div className="guided-line-copy">
        <span>{name}</span>
        <h2>“{line.text}”</h2>
        <small>
          {formatTimestamp(line.startMs)}–{formatTimestamp(line.endMs)} ·{' '}
          {((line.endMs - line.startMs) / 1_000).toFixed(1)} saniye
        </small>
      </div>
      <div className="guided-actions">
        {!contextDone && !contextPlaying && (
          <>
            <button
              type="button"
              className="button button-secondary"
              disabled={scene.mediaStatus !== 'available'}
              onClick={onContext}
            >
              Önce sahneyi izle
            </button>
            <button type="button" className="text-button" onClick={onSkip}>
              İzlemeden geç
            </button>
          </>
        )}
        {contextPlaying && (
          <span role="status">Kaynak sesi açık; repliğin sonuna kadar bağlam oynatılıyor…</span>
        )}
        {contextDone && (
          <button
            type="button"
            className="button button-primary"
            disabled={scene.mediaStatus !== 'available'}
            onClick={onAttempt}
          >
            Şimdi Seslendir
          </button>
        )}
      </div>
    </section>
  )
}

function DubbingAttempt({
  line,
  characterName: name,
  timing,
  recorderPhase,
}: {
  line: DialogueLine
  characterName: string
  timing: ReturnType<typeof getGuidedLineTiming>
  recorderPhase: ReturnType<typeof useGuidedLineRecorder>['phase']
}) {
  const cue = timing.speaking
    ? 'ŞİMDİ KONUŞ'
    : timing.afterCanonical
      ? 'Cümleni bitir'
      : timing.countdown
        ? String(timing.countdown)
        : 'Hazırlan'
  return (
    <section className="guided-step attempt-step">
      <span className="eyebrow">
        {name} · “{line.text}”
      </span>
      <div className={`speaking-cue ${timing.speaking ? 'is-speaking' : ''}`} role="status">
        {cue}
      </div>
      <SpeakingTimeline line={line} timing={timing} />
      <p className="truth-note">
        Kaynak video sessiz. Kayıt, konuşmadan kısa süre önce başlayıp bitişten kısa süre sonra
        otomatik durur.
      </p>
      <strong className="attempt-status">
        {recorderPhase === 'recording'
          ? timing.afterCanonical
            ? 'Cümleni doğal biçimde bitir; kayıt birazdan duracak.'
            : `Kalan konuşma süresi: ${(timing.remainingSpeakingMs / 1_000).toFixed(1)} sn`
          : 'Kayıt başlangıcı bekleniyor'}
      </strong>
    </section>
  )
}

function SpeakingTimeline({
  line,
  timing,
}: {
  line: DialogueLine
  timing: ReturnType<typeof getGuidedLineTiming>
}) {
  const leadWidth =
    ((timing.preparationHoldMs + timing.captureStartMs - timing.preRollStartMs) /
      timing.totalDurationMs) *
    100
  const preGraceWidth = ((line.startMs - timing.captureStartMs) / timing.totalDurationMs) * 100
  const speakingWidth = ((line.endMs - line.startMs) / timing.totalDurationMs) * 100
  const postGraceWidth = ((timing.captureEndMs - line.endMs) / timing.totalDurationMs) * 100
  return (
    <div className="speaking-timeline" aria-label="Replik zaman çizelgesi">
      <div className="timeline-labels">
        <span>Ön hazırlık</span>
        <span>
          Konuşma: {formatTimestamp(line.startMs)}–{formatTimestamp(line.endMs)}
        </span>
      </div>
      <div
        className="timeline-track"
        role="progressbar"
        aria-label="Konuşma süresi ilerlemesi"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(timing.speakingProgress * 100)}
      >
        <span className="pre-roll-region" style={{ width: `${leadWidth}%` }} />
        <span
          className="capture-grace-region"
          style={{ left: `${leadWidth}%`, width: `${preGraceWidth}%` }}
        />
        <span
          className="speaking-region"
          style={{ left: `${leadWidth + preGraceWidth}%`, width: `${speakingWidth}%` }}
        />
        <span
          className="capture-grace-region post"
          style={{
            left: `${leadWidth + preGraceWidth + speakingWidth}%`,
            width: `${postGraceWidth}%`,
          }}
        />
        <span
          className="speaking-fill"
          style={{
            left: `${leadWidth + preGraceWidth}%`,
            width: `${timing.speakingProgress * speakingWidth}%`,
          }}
        />
        <i className="timeline-playhead" style={{ left: `${timing.playheadProgress * 100}%` }} />
      </div>
    </div>
  )
}

function TakeReview({
  line,
  characterName: name,
  draft,
  saving,
  uploadError,
  audioRef,
  onListen,
  onRetry,
  onConfirm,
}: {
  line: DialogueLine
  characterName: string
  draft: LocalLineRecording
  saving: boolean
  uploadError: string | null
  audioRef: RefObject<HTMLAudioElement | null>
  onListen: () => void
  onRetry: () => void
  onConfirm: () => void
}) {
  return (
    <section className="guided-step">
      <span className="eyebrow">4 · Çekimi kontrol et</span>
      <h2>Kaydın hazır</h2>
      <div className="guided-line-copy">
        <span>{name}</span>
        <strong>“{line.text}”</strong>
        <small>
          Doğal bitiriş payıyla kaydedilen çekim: {(draft.durationMs / 1_000).toFixed(1)} saniye
        </small>
      </div>
      <audio ref={audioRef} src={draft.objectUrl} preload="metadata" />
      {uploadError && (
        <p className="recording-error" role="alert">
          {uploadError} Yerel çekimin korunuyor.
        </p>
      )}
      <div className="guided-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={saving}
          onClick={onListen}
        >
          Dinle
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={saving}
          onClick={onRetry}
        >
          Tekrar Kaydet
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={saving}
          onClick={onConfirm}
        >
          {saving ? 'Kaydediliyor…' : uploadError ? 'Yüklemeyi Yeniden Dene' : 'Onayla'}
        </button>
      </div>
      {saving && (
        <p role="status" className="saving-state">
          Ses kaydın yetkili özel depoya kaydediliyor…
        </p>
      )}
    </section>
  )
}

function PlayerProgress({ room, playerId }: { room: Room; playerId: string }) {
  return (
    <section
      className="guided-side-card room-recording-progress"
      aria-labelledby="player-progress-title"
    >
      <span className="eyebrow">Sunucu onaylı durum</span>
      <h2 id="player-progress-title">Oyuncu ilerlemesi</h2>
      {room.recordingProgress ? (
        <ul aria-label="Oyuncu kayıt ilerlemesi">
          {room.players.map((player) => {
            const progress = room.recordingProgress?.players.find(
              (entry) => entry.playerId === player.id,
            )
            return progress ? (
              <li key={player.id} data-testid={`player-${player.nickname}`}>
                <span>
                  {player.nickname}
                  {player.id === playerId ? ' (sen)' : ''}
                </span>
                {player.id === room.hostId && <strong>Kurucu</strong>}
                <small>{player.connected ? 'Oyunda' : 'Çevrimdışı'}</small>
                <em>
                  {progress.spectator
                    ? 'Seyirci'
                    : `${progress.uploaded} / ${progress.required}${progress.complete ? ' · Tamam' : ''}`}
                </em>
              </li>
            ) : null
          })}
        </ul>
      ) : (
        <p>İlerleme sunucudan bekleniyor…</p>
      )}
    </section>
  )
}

function CompletionState({
  room,
  playerId,
  onFinalize,
}: {
  room: Room
  playerId: string
  onFinalize: () => void
}) {
  const progress = room.recordingProgress
  return (
    <section className="guided-step guided-centered completion-state">
      <span className="eyebrow">Senin görevin tamamlandı</span>
      <h2>Tüm repliklerini tamamladın</h2>
      <p>
        {progress?.readyForFinalization
          ? 'Bütün oyuncular hazır. Final hazırlığı başlayabilir.'
          : 'Diğer oyuncular kayıtlarını tamamlarken burada bekleyebilirsin.'}
      </p>
      {progress?.readyForFinalization && room.hostId === playerId && (
        <button type="button" className="button button-primary" onClick={onFinalize}>
          Son Hazırlığı Başlat
        </button>
      )}
      {progress?.readyForFinalization && room.hostId !== playerId && (
        <p role="status">Oda kurucusunun son hazırlığı başlatması bekleniyor.</p>
      )}
    </section>
  )
}

function GuidedVideo({
  scene,
  videoRef,
  controls,
  muted,
  onClock,
  onPlay,
  onPause,
  onError,
}: { scene: Scene; controls: boolean; muted: boolean; onError?: () => void } & VideoEvents) {
  if (scene.mediaStatus !== 'available')
    return (
      <div className="media-unavailable">
        <strong>Bu sahnenin oynatılabilir videosu henüz hazır değil.</strong>
      </div>
    )
  return (
    <div className="video-shell guided-video">
      <video
        ref={videoRef}
        src={scene.videoUrl}
        poster={scene.thumbnailUrl}
        controls={controls}
        muted={muted}
        playsInline
        preload="metadata"
        onLoadedMetadata={onClock}
        onTimeUpdate={onClock}
        onSeeking={onClock}
        onSeeked={onClock}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={() => {
          onClock()
          onPause()
        }}
        onError={onError}
      >
        Tarayıcın video oynatmayı desteklemiyor.
      </video>
    </div>
  )
}

function ProcessingExperience({
  room,
  session,
  scene,
  connectionStatus,
}: {
  room: Room
  session: RoomSession
  scene: Scene
  connectionStatus: ConnectionSnapshot['status']
}) {
  return (
    <section className="playback-page">
      <header className="playback-heading">
        <div>
          <span className="eyebrow">Son hazırlık başladı · Oda {room.code}</span>
          <h1>{scene.title}</h1>
        </div>
        <span
          role="status"
          className={`connection-badge ${connectionStatus === 'connected' ? 'is-online' : ''}`}
        >
          <span />
          {connectionStatus === 'connected' ? 'Bağlı' : 'Bağlantı kesildi'}
        </span>
      </header>
      {room.recordingManifest && room.hostId === session.playerId && (
        <RenderPanel manifest={room.recordingManifest} session={session} scene={scene} />
      )}
      {room.hostId !== session.playerId && (
        <section className="render-panel" aria-labelledby="result-wait-title">
          <span className="eyebrow">Final video hazırlanıyor</span>
          <h2 id="result-wait-title">Sonucun hazırlanması bekleniyor</h2>
          <p role="status">
            Oda kurucusu videoyu hazırlayıp yüklüyor. Sonuç hazır olduğunda bu ekran otomatik
            yenilenecek.
          </p>
        </section>
      )}
      <div className="processing-progress">
        <PlayerProgress room={room} playerId={session.playerId} />
        <p className="truth-note">Diğer oyuncuların kayıtları final videoya kadar gizli.</p>
      </div>
    </section>
  )
}

function characterName(scene: Scene, line: DialogueLine) {
  return scene.characters.find((character) => character.id === line.characterId)?.name ?? 'Karakter'
}

function waitForMediaMetadata(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const loaded = () => {
      cleanup()
      resolve()
    }
    const failed = () => {
      cleanup()
      reject(new Error('media failed'))
    }
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', loaded)
      video.removeEventListener('error', failed)
    }
    video.addEventListener('loadedmetadata', loaded, { once: true })
    video.addEventListener('error', failed, { once: true })
  })
}

function waitForMediaSeek(video: HTMLVideoElement) {
  if (!video.seeking) return Promise.resolve()
  return new Promise<void>((resolve) =>
    video.addEventListener('seeked', () => resolve(), { once: true }),
  )
}
