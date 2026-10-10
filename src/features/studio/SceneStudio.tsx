import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type {
  AiAnalysis,
  DialogueLine,
  PreparationDraft,
  SeparationResult,
  UploadedMedia,
} from '../../../shared/types'
import {
  cancelLocalAiJob,
  createLocalAiJob,
  getLocalAiHealth,
  getLocalAiJob,
  cancelLocalSeparationJob,
  createLocalSeparationJob,
  fetchLocalSeparationBackground,
  getLocalSeparationHealth,
  getLocalSeparationJob,
} from '../../lib/ai/companion'
import {
  deletePrivateScene,
  fetchPrivateSceneSource,
  fetchPrivateSceneBackground,
  getPrivateScene,
  savePrivateScene,
  uploadPrivateVideo,
  uploadPrivateSceneBackground,
  uploadPrivateSceneThumbnail,
} from '../../lib/api/studio'
import { captureVideoTimeMs, inspectVideoFile, type VideoMetadata } from '../../lib/studio/media'
import { generateVideoThumbnail, type GeneratedThumbnail } from '../../lib/studio/thumbnail'
import { formatTimestamp } from '../../lib/time'
import {
  buildPrivateScene,
  canonicalLineOrder,
  deleteDialogueLine,
  editableFromAiDraft,
  editableFromScene,
  mergeWithNextDialogueLine,
  nudgeDialogueBoundary,
  removeCharacterSafely,
  sceneValidationMessages,
  splitDialogueLine,
  type EditableScene,
} from './sceneDraft'

const emptyEditable: EditableScene = { title: '', description: '', characters: [], lines: [] }
const speakerColors = ['#9a85ff', '#e6ab65', '#65c7b2', '#ee7aa9', '#78a9ff', '#c3d86b']
const nudgeValues = [-100, -50, 50, 100]
const aiStageText = {
  connecting: 'Yerel AI servisine bağlanılıyor',
  queued: 'Yerel AI işi sırada bekliyor',
  preparing_audio: 'Ses hazırlanıyor',
  transcribing: 'Konuşmalar yazıya dökülüyor',
  diarizing: 'Konuşmacılar belirleniyor',
  merging: 'Zamanlamalar birleştiriliyor',
  building_draft: 'Taslak hazırlanıyor',
} as const

const separationStageText = {
  connecting: 'Yerel yardımcı kontrol ediliyor',
  queued: 'Ayırma işi sırada bekliyor',
  loading_model: 'Yerel ayırıcı hazırlanıyor',
  separating: 'Konuşmalar ayrılıyor',
  encoding: 'Arka plan sesi hazırlanıyor',
} as const

export function SceneStudio() {
  const { sceneId } = useParams()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const transcriptTextRef = useRef<HTMLTextAreaElement>(null)
  const auditionEndRef = useRef<number | null>(null)
  const aiAbortRef = useRef<AbortController | null>(null)
  const separationAbortRef = useRef<AbortController | null>(null)
  const [draft, setDraft] = useState<PreparationDraft | null>(null)
  const [editable, setEditable] = useState(emptyEditable)
  const [file, setFile] = useState<File | null>(null)
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null)
  const [thumbnailCandidate, setThumbnailCandidate] = useState<GeneratedThumbnail | null>(null)
  const [thumbnailNotice, setThumbnailNotice] = useState<string | null>(null)
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiStage, setAiStage] = useState<keyof typeof aiStageText | null>(null)
  const [aiJobId, setAiJobId] = useState<string | null>(null)
  const [separationBusy, setSeparationBusy] = useState(false)
  const [backgroundUploading, setBackgroundUploading] = useState(false)
  const [separationStage, setSeparationStage] = useState<
    keyof typeof separationStageText | 'ready' | 'accepted' | 'cancelled' | 'failed' | null
  >(null)
  const [separationJobId, setSeparationJobId] = useState<string | null>(null)
  const [separationNotice, setSeparationNotice] = useState<string | null>(null)
  const [savedBackgroundUrl, setSavedBackgroundUrl] = useState<string | null>(null)
  const [backgroundCandidate, setBackgroundCandidate] = useState<{
    blob: Blob
    url: string
    metadata: SeparationResult
  } | null>(null)
  const [reviewedWarnings, setReviewedWarnings] = useState<Set<string>>(new Set())
  const [expectedSpeakerCount, setExpectedSpeakerCount] = useState<number | null>(null)
  const [onlyWarnings, setOnlyWarnings] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sceneId) return
    const controller = new AbortController()
    void Promise.all([
      getPrivateScene(sceneId, controller.signal),
      fetchPrivateSceneSource(sceneId, controller.signal),
    ])
      .then(async ([response, blob]) => {
        setDraft(response.draft)
        if (response.draft.scene) setEditable(editableFromScene(response.draft.scene))
        setSourceBlob(blob)
        const url = URL.createObjectURL(blob)
        setSourceUrl(url)
        if (response.draft.backgroundAudio) {
          const background = await fetchPrivateSceneBackground(sceneId, controller.signal)
          if (!controller.signal.aborted) setSavedBackgroundUrl(URL.createObjectURL(background))
        }
      })
      .catch((failure: unknown) => !controller.signal.aborted && setError(message(failure)))
    return () => controller.abort()
  }, [sceneId])

  useEffect(
    () => () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl)
    },
    [sourceUrl],
  )

  useEffect(() => () => aiAbortRef.current?.abort(), [])
  useEffect(() => () => separationAbortRef.current?.abort(), [])
  useEffect(
    () => () => {
      if (savedBackgroundUrl) URL.revokeObjectURL(savedBackgroundUrl)
    },
    [savedBackgroundUrl],
  )
  useEffect(
    () => () => {
      if (backgroundCandidate) URL.revokeObjectURL(backgroundCandidate.url)
    },
    [backgroundCandidate],
  )

  const media: UploadedMedia | null =
    draft?.media ??
    (metadata
      ? {
          sceneId: '',
          filename: metadata.filename,
          mimeType: metadata.mimeType,
          byteSize: metadata.byteSize,
          durationMs: metadata.durationMs,
          width: metadata.width,
          height: metadata.height,
          uploadedAt: 0,
        }
      : null)
  const validation = draft ? sceneValidationMessages(draft.media, editable) : []
  const orderedLines = useMemo(() => canonicalLineOrder(editable.lines), [editable.lines])
  const selectedLine = orderedLines.find((line) => line.id === selectedLineId) ?? null
  const activeLines = editable.lines.filter(
    (line) => playheadMs >= line.startMs && playheadMs < line.endMs,
  )
  const lineCounts = useMemo(
    () =>
      Object.fromEntries(
        editable.characters.map((character) => [
          character.id,
          editable.lines.filter((line) => line.characterId === character.id).length,
        ]),
      ),
    [editable],
  )
  const warningCodesByLine = useMemo(
    () =>
      Object.fromEntries(
        (draft?.aiAnalysis?.lineAnalysis ?? []).map((analysis) => [
          analysis.lineId,
          analysis.warningCodes,
        ]),
      ),
    [draft?.aiAnalysis],
  )
  const warningLineIds = orderedLines
    .filter((line) => (warningCodesByLine[line.id]?.length ?? 0) > 0)
    .map((line) => line.id)
  const visibleLines = onlyWarnings
    ? orderedLines.filter((line) => warningLineIds.includes(line.id))
    : orderedLines

  useEffect(() => {
    if (!selectedLineId) return
    const selected = [
      ...(transcriptRef.current?.querySelectorAll<HTMLElement>('[data-line-id]') ?? []),
    ].find((entry) => entry.dataset.lineId === selectedLineId)
    selected?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedLineId, onlyWarnings])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, button')) return
      const video = videoRef.current
      if (!video) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (video.paused) void video.play()
        else video.pause()
      } else if (event.key.toLowerCase() === 'j') {
        event.preventDefault()
        video.currentTime = Math.max(0, video.currentTime - 0.25)
      } else if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 0.25)
      } else if (event.key.toLowerCase() === 'i') {
        event.preventDefault()
        if (selectedLine && draft)
          setEditable((current) => ({
            ...current,
            lines: current.lines.map((line) =>
              line.id === selectedLine.id
                ? {
                    ...line,
                    startMs: captureVideoTimeMs(video.currentTime, draft.media.durationMs),
                  }
                : line,
            ),
          }))
      } else if (event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (selectedLine && draft)
          setEditable((current) => ({
            ...current,
            lines: current.lines.map((line) =>
              line.id === selectedLine.id
                ? {
                    ...line,
                    endMs: captureVideoTimeMs(video.currentTime, draft.media.durationMs),
                  }
                : line,
            ),
          }))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  async function choose(nextFile: File | undefined) {
    if (!nextFile) return
    setError(null)
    setFile(null)
    setMetadata(null)
    setThumbnailCandidate(null)
    setThumbnailNotice(null)
    try {
      const inspected = await inspectVideoFile(nextFile)
      setFile(nextFile)
      setSourceBlob(nextFile)
      setMetadata(inspected)
      setEditable((current) => ({
        ...current,
        title: current.title || nextFile.name.replace(/\.[^.]+$/, ''),
      }))
      setSourceUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return URL.createObjectURL(nextFile)
      })
      try {
        const thumbnail = await generateVideoThumbnail(nextFile, inspected)
        setThumbnailCandidate(thumbnail)
        setThumbnailNotice(
          `${formatTimestamp(thumbnail.capturedAtMs)} karesinden özel küçük resim hazırlandı.`,
        )
      } catch {
        setThumbnailNotice(
          'Küçük resim bu tarayıcıda hazırlanamadı; sahneyi yine de kaydedebilirsin.',
        )
      }
    } catch (failure) {
      setError(message(failure))
    }
  }

  async function upload() {
    if (!file || !metadata) return
    setBusy(true)
    setError(null)
    try {
      const response = await uploadPrivateVideo(file, metadata)
      let nextDraft = response.draft
      if (thumbnailCandidate) {
        try {
          const thumbnailResponse = await uploadPrivateSceneThumbnail(
            response.draft.media.sceneId,
            thumbnailCandidate,
          )
          nextDraft = thumbnailResponse.draft
          setThumbnailCandidate(null)
          setThumbnailNotice('Küçük resim sahnenin özel alanına kaydedildi.')
        } catch {
          setThumbnailNotice(
            'Video yüklendi fakat küçük resim kaydedilemedi. Sahneyi kaydederken yeniden denenecek.',
          )
        }
      }
      setDraft(nextDraft)
      navigate(`/studio/${response.draft.media.sceneId}`, { replace: true })
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (!draft) return
    const parsed = buildPrivateScene(draft.media, editable, draft.scene?.origin.version ?? 0)
    if (!parsed.success) {
      setError('Kaydetmeden önce doğrulama hatalarını düzelt.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      let pendingThumbnail = thumbnailCandidate
      if (!draft.thumbnail && !pendingThumbnail && sourceBlob) {
        try {
          pendingThumbnail = await generateVideoThumbnail(sourceBlob, draft.media)
          setThumbnailCandidate(pendingThumbnail)
        } catch {
          setThumbnailNotice(
            'Küçük resim hazırlanamadı; sahne eski kayıtlarla uyumlu görsel yer tutucuyla kaydedildi.',
          )
        }
      }
      if (pendingThumbnail) {
        try {
          await uploadPrivateSceneThumbnail(draft.media.sceneId, pendingThumbnail)
          setThumbnailCandidate(null)
          setThumbnailNotice('Küçük resim sahnenin özel alanına kaydedildi.')
        } catch {
          setThumbnailNotice(
            'Küçük resim yüklenemedi; sahne zarar görmeden görsel yer tutucuyla kaydedildi.',
          )
        }
      }
      const response = await savePrivateScene(parsed.data)
      setDraft(response.draft)
      navigate(`/scenes/${parsed.data.id}`)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  async function createAiDraft() {
    if (!draft || !sourceBlob) return
    if (
      (editable.characters.length > 0 || editable.lines.length > 0) &&
      !confirm('AI taslağı mevcut karakter ve replik taslağının yerini alacak. Devam edilsin mi?')
    )
      return
    const controller = new AbortController()
    aiAbortRef.current = controller
    setAiBusy(true)
    setAiStage('connecting')
    setAiJobId(null)
    setError(null)
    try {
      await getLocalAiHealth(controller.signal)
      setAiStage('queued')
      const created = await createLocalAiJob(
        sourceBlob,
        draft.media,
        expectedSpeakerCount,
        controller.signal,
      )
      setAiJobId(created.id)
      let job = created
      while (job.status === 'queued' || job.status === 'running') {
        setAiStage(job.stage)
        await pollingDelay(controller.signal)
        job = await getLocalAiJob(job.id, controller.signal)
      }
      if (job.status === 'cancelled') return
      if (job.status === 'failed') throw new Error(job.error ?? 'Yerel AI analizi tamamlanamadı.')
      if (!job.result) throw new Error('Yerel AI taslak sonucu eksik.')
      setEditable((current) => editableFromAiDraft(current, job.result!))
      setDraft((current) =>
        current
          ? {
              ...current,
              aiAnalysis: job.result!.analysis,
              warnings: job.result!.analysis.warnings.map((warning) => warning.message),
            }
          : current,
      )
      setSelectedLineId(job.result.lines[0]?.id ?? null)
      setReviewedWarnings(new Set())
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure))
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null
      setAiBusy(false)
      setAiJobId(null)
      setAiStage(null)
    }
  }

  async function cancelAiDraft() {
    if (aiJobId) await cancelLocalAiJob(aiJobId).catch(() => undefined)
    aiAbortRef.current?.abort()
    setAiBusy(false)
    setAiStage(null)
    setAiJobId(null)
  }

  async function createBackgroundCandidate() {
    if (!draft || !sourceBlob) return
    const controller = new AbortController()
    separationAbortRef.current = controller
    setSeparationBusy(true)
    setSeparationStage('connecting')
    setSeparationJobId(null)
    setSeparationNotice(null)
    try {
      const health = await getLocalSeparationHealth(controller.signal)
      if (health.status !== 'ready') {
        setSeparationStage('failed')
        setSeparationNotice(
          health.issues.map((issue) => issue.message).join(' ') ||
            'Gerekli yerel ayırma modeli hazır değil.',
        )
        return
      }
      setSeparationStage('queued')
      const created = await createLocalSeparationJob(
        sourceBlob,
        draft.media,
        'auto',
        controller.signal,
      )
      setSeparationJobId(created.id)
      let job = created
      while (job.status === 'queued' || job.status === 'running') {
        setSeparationStage(job.stage)
        await pollingDelay(controller.signal)
        job = await getLocalSeparationJob(job.id, controller.signal)
      }
      if (job.status === 'cancelled') {
        setSeparationStage('cancelled')
        setSeparationNotice(
          'Ayırma işlemi iptal edildi. Sahneyi arka plansız hazırlamaya devam edebilirsin.',
        )
        return
      }
      if (job.status === 'failed') throw new Error(job.error ?? 'Konuşmalar ayrılamadı.')
      if (!job.result) throw new Error('Hazırlanan arka plan bilgisi eksik.')
      const blob = await fetchLocalSeparationBackground(job.id, controller.signal)
      await cancelLocalSeparationJob(job.id).catch(() => undefined)
      const url = URL.createObjectURL(blob)
      setBackgroundCandidate((current) => {
        if (current) URL.revokeObjectURL(current.url)
        return { blob, url, metadata: job.result! }
      })
      setSeparationStage('ready')
      setSeparationNotice(
        'Konuşmasız arka plan hazır. Dinleyip uygun bulursan açıkça kullanmayı seç.',
      )
    } catch (failure) {
      if (!controller.signal.aborted) {
        setSeparationStage('failed')
        setSeparationNotice(message(failure))
      }
    } finally {
      if (separationAbortRef.current === controller) separationAbortRef.current = null
      setSeparationBusy(false)
      setSeparationJobId(null)
    }
  }

  async function cancelBackgroundSeparation() {
    if (separationJobId) await cancelLocalSeparationJob(separationJobId).catch(() => undefined)
    separationAbortRef.current?.abort()
    setSeparationBusy(false)
    setSeparationStage('cancelled')
    setSeparationJobId(null)
    setSeparationNotice('Ayırma işlemi iptal edildi. Mevcut kayıtlı arka plan değişmedi.')
  }

  async function acceptBackgroundCandidate() {
    if (!draft || !backgroundCandidate) return
    setBackgroundUploading(true)
    setSeparationNotice(null)
    try {
      const response = await uploadPrivateSceneBackground(
        draft.media.sceneId,
        backgroundCandidate.blob,
        backgroundCandidate.metadata,
      )
      setDraft(response.draft)
      setSavedBackgroundUrl((current) => {
        if (current) URL.revokeObjectURL(current)
        return URL.createObjectURL(backgroundCandidate.blob)
      })
      setSeparationStage('accepted')
      setSeparationNotice('Konuşmasız arka plan bu sahne için özel olarak kaydedildi.')
    } catch (failure) {
      setSeparationStage('ready')
      setSeparationNotice(
        `${message(failure)} Yerel ön izleme korundu; ayırmayı yeniden çalıştırmadan tekrar deneyebilirsin.`,
      )
    } finally {
      setBackgroundUploading(false)
    }
  }

  function addCharacter() {
    const id = stableId(
      'karakter',
      editable.characters.map((entry) => entry.id),
    )
    setEditable((current) => ({
      ...current,
      characters: [
        ...current.characters,
        { id, name: `Karakter ${current.characters.length + 1}` },
      ],
    }))
  }
  function removeCharacter(id: string) {
    const result = removeCharacterSafely(editable, id)
    setError(result.error)
    setEditable(result.editable)
  }
  function addLine() {
    if (!editable.characters[0]) {
      setError('Önce bir karakter ekle.')
      return
    }
    const id = stableId(
      'replik',
      editable.lines.map((entry) => entry.id),
    )
    const startMs = Math.min(playheadMs, Math.max(0, (draft?.media.durationMs ?? 1000) - 1))
    const endMs = Math.min(draft?.media.durationMs ?? startMs + 1000, startMs + 1000)
    setEditable((current) => ({
      ...current,
      lines: [
        ...current.lines,
        { id, characterId: current.characters[0]!.id, text: '', startMs, endMs },
      ],
    }))
    setSelectedLineId(id)
  }
  function updateLine(id: string, patch: Partial<DialogueLine>) {
    setEditable((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    }))
  }
  function capture(which: 'startMs' | 'endMs') {
    if (!selectedLine || !draft) return
    updateLine(selectedLine.id, {
      [which]: captureVideoTimeMs(videoRef.current?.currentTime ?? 0, draft.media.durationMs),
    })
  }

  function navigateLines(direction: -1 | 1, warningsOnly = false) {
    const candidates = warningsOnly ? warningLineIds : orderedLines.map((line) => line.id)
    if (!candidates.length) return
    const current = selectedLineId ? candidates.indexOf(selectedLineId) : -1
    const next = current < 0 ? (direction > 0 ? 0 : candidates.length - 1) : current + direction
    setSelectedLineId(candidates[Math.max(0, Math.min(candidates.length - 1, next))] ?? null)
  }

  function splitSelectedLine() {
    if (!selectedLine || !draft) return
    const textIndex = transcriptTextRef.current?.selectionStart
    const result = splitDialogueLine(editable, selectedLine.id, playheadMs, textIndex)
    setError(result.error)
    if (result.error || !result.newLineId) return
    setEditable(result.editable)
    setDraft((current) =>
      current?.aiAnalysis
        ? {
            ...current,
            aiAnalysis: splitAiAnalysis(
              current.aiAnalysis,
              selectedLine.id,
              result.newLineId!,
              playheadMs,
            ),
          }
        : current,
    )
    setSelectedLineId(result.newLineId)
  }

  function mergeSelectedLine() {
    if (!selectedLine) return
    const result = mergeWithNextDialogueLine(editable, selectedLine.id)
    setError(result.error)
    if (result.error || !result.removedLineId) return
    setEditable(result.editable)
    setDraft((current) =>
      current?.aiAnalysis
        ? {
            ...current,
            aiAnalysis: mergeAiAnalysis(current.aiAnalysis, selectedLine.id, result.removedLineId!),
          }
        : current,
    )
  }

  function auditionSelectedLine() {
    if (!selectedLine || !videoRef.current || !draft) return
    const startMs = Math.max(0, selectedLine.startMs - 250)
    auditionEndRef.current = Math.min(draft.media.durationMs, selectedLine.endMs + 250)
    videoRef.current.currentTime = startMs / 1000
    void videoRef.current.play()
  }

  function addAndAssignSpeaker() {
    if (!selectedLine) {
      addCharacter()
      return
    }
    const id = stableId(
      'karakter',
      editable.characters.map((entry) => entry.id),
    )
    setEditable((current) => ({
      ...current,
      characters: [
        ...current.characters,
        { id, name: `Karakter ${current.characters.length + 1}` },
      ],
      lines: current.lines.map((line) =>
        line.id === selectedLine.id ? { ...line, characterId: id } : line,
      ),
    }))
  }

  if (!draft)
    return (
      <section className="studio-page">
        <Link to="/" className="back-link">
          ← Sahne arşivine dön
        </Link>
        <span className="eyebrow">Özel ve yalnızca sana ait</span>
        <h1>Sahne Stüdyosu</h1>
        <p>
          Klibini yükle, replikleri elle zamanla ve arkadaşlarınla oynanabilir bir sahne hazırla.
        </p>
        <div className="copyright-notice">
          Yalnızca kullanma iznin olan içerikleri yükle. Sahnen herkese açık yayımlanmaz.
        </div>
        <label
          className="studio-drop"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event: DragEvent) => {
            event.preventDefault()
            void choose(event.dataTransfer.files[0])
          }}
        >
          <strong>Klibini seç veya buraya bırak</strong>
          <span>WebM veya MP4 · en fazla 25 MB · en fazla 10 dakika</span>
          <input
            type="file"
            accept="video/webm,video/mp4"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        {metadata && <MediaFacts media={media!} />}
        {thumbnailNotice && <p className="studio-notice">{thumbnailNotice}</p>}
        {sourceUrl && (
          <video className="studio-video" src={sourceUrl} controls preload="metadata" />
        )}
        {error && (
          <p className="room-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button button-primary"
          disabled={!file || !metadata || busy}
          onClick={() => void upload()}
        >
          {busy ? 'Yükleniyor…' : 'Videoyu özel alana yükle'}
        </button>
      </section>
    )

  return (
    <section className="studio-page">
      <Link to="/" className="back-link">
        ← Sahne arşivine dön
      </Link>
      <div className="studio-heading">
        <div>
          <span className="eyebrow">
            Sahne Stüdyosu ·{' '}
            {draft.status === 'prepared'
              ? `Sürüm ${draft.scene?.origin.version}`
              : 'Hazırlık taslağı'}
          </span>
          <h1>{editable.title || 'Yeni sahne hazırla'}</h1>
        </div>
        {draft.status === 'prepared' && (
          <button
            className="text-button danger"
            onClick={async () => {
              if (
                !confirm(
                  'Bu özel sahneyi silmek istediğine emin misin? Aktif odaların kopyaları korunur.',
                )
              )
                return
              await deletePrivateScene(draft.media.sceneId)
              navigate('/')
            }}
          >
            Sahneyi sil
          </button>
        )}
      </div>
      {thumbnailNotice && <p className="studio-notice">{thumbnailNotice}</p>}
      <MediaFacts media={draft.media} />
      <section className="studio-ai" aria-live="polite">
        <div>
          <span className="eyebrow">Bilgisayarında çalışan yerel AI</span>
          <h2>İlk taslağı konuşmalardan çıkar</h2>
          <p>
            Klip ve transkript dış bir AI servisine gönderilmez. Model ağırlıkları yalnızca açık
            model kurulumu sırasında indirilir. Müzik ve efektler henüz ayrılmadığı için gürültülü
            sahnelerde sonuç zayıflayabilir.
          </p>
        </div>
        <div className="studio-ai-actions">
          <label>
            Beklenen konuşmacı sayısı
            <select
              aria-label="Beklenen konuşmacı sayısı"
              disabled={aiBusy}
              value={expectedSpeakerCount ?? ''}
              onChange={(event) =>
                setExpectedSpeakerCount(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">Otomatik</option>
              {Array.from({ length: 12 }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
            <small>Yalnızca yeni AI taslağını etkiler.</small>
          </label>
          <button
            className="button button-secondary"
            disabled={busy || aiBusy || !sourceBlob}
            onClick={() => void createAiDraft()}
          >
            {aiBusy ? aiStageText[aiStage ?? 'queued'] : 'AI ile Taslak Oluştur'}
          </button>
          {aiBusy && (
            <button className="text-button danger" onClick={() => void cancelAiDraft()}>
              Analizi iptal et
            </button>
          )}
        </div>
      </section>
      <section className="studio-ai studio-background" aria-live="polite">
        <div>
          <span className="eyebrow">Arka plan sesi</span>
          <h2>Konuşmaları kaldır, müzik ve ortam seslerini koru</h2>
          <p>
            Ayırma yalnızca bu bilgisayardaki yerel yardımcıyla çalışır. Hazırlanan ses önce
            dinlenir; sen onaylamadan sahneye kaydedilmez. Bu adım isteğe bağlıdır.
          </p>
          {draft.backgroundAudio && (
            <p className="background-saved">
              <strong>Kaydedilmiş arka plan hazır.</strong>{' '}
              {(draft.backgroundAudio.byteSize / 1024 / 1024).toFixed(2)} MB · stereo ·{' '}
              {draft.backgroundAudio.sampleRate / 1000} kHz
            </p>
          )}
        </div>
        <div className="studio-ai-actions background-actions">
          <button
            className="button button-secondary"
            disabled={busy || separationBusy || backgroundUploading || !sourceBlob}
            onClick={() => void createBackgroundCandidate()}
          >
            {separationBusy && separationStage && separationStage in separationStageText
              ? separationStageText[separationStage as keyof typeof separationStageText]
              : backgroundCandidate || draft.backgroundAudio
                ? 'Yeniden Oluştur'
                : 'Konuşmaları Ayır'}
          </button>
          {separationBusy && (
            <button
              className="text-button danger"
              onClick={() => void cancelBackgroundSeparation()}
            >
              Ayırmayı iptal et
            </button>
          )}
          {backgroundCandidate && (
            <div className="background-preview">
              <span>Konuşmasız arka plan ön izlemesi</span>
              <audio
                aria-label="Konuşmasız arka plan ön izlemesi"
                id="background-candidate-player"
                src={backgroundCandidate.url}
                controls
              />
              <button
                className="button button-primary"
                disabled={backgroundUploading || separationBusy}
                onClick={() => void acceptBackgroundCandidate()}
              >
                {backgroundUploading ? 'Özel alana kaydediliyor…' : 'Arka Planı Kullan'}
              </button>
            </div>
          )}
          {!backgroundCandidate && savedBackgroundUrl && (
            <div className="background-preview">
              <span>Kaydedilmiş konuşmasız arka plan</span>
              <audio
                aria-label="Kaydedilmiş konuşmasız arka plan"
                id="saved-background-player"
                src={savedBackgroundUrl}
                controls
              />
            </div>
          )}
          {separationNotice && (
            <p
              className={separationStage === 'failed' ? 'room-error' : 'field-help'}
              role={separationStage === 'failed' ? 'alert' : 'status'}
            >
              {separationNotice}
            </p>
          )}
        </div>
      </section>
      {draft.aiAnalysis && (
        <section className="studio-ai-review">
          <div className="editor-title">
            <div>
              <span className="eyebrow">İnsan incelemesi gerekli</span>
              <h2>AI taslak notları</h2>
            </div>
            <p>
              {draft.aiAnalysis.detectedLanguage
                ? `Algılanan dil: ${draft.aiAnalysis.detectedLanguage}`
                : 'Dil belirlenemedi'}{' '}
              · {draft.aiAnalysis.device === 'cuda' ? 'NVIDIA GPU' : 'CPU'}
            </p>
          </div>
          <p>
            Bu notlar doğrulama değildir. Konuşmacıları yeniden adlandırabilir, metni ve zamanları
            düzeltebilir, replik ekleyip silebilirsin. Sahne yalnızca aşağıdaki normal doğrulama ve
            kaydetme adımıyla oynanabilir olur.
          </p>
          {draft.aiAnalysis.warnings.length > 0 ? (
            <ul className="ai-warning-list">
              {draft.aiAnalysis.warnings.map((warning, index) => {
                const key = `${warning.code}-${warning.lineId ?? 'scene'}-${index}`
                if (reviewedWarnings.has(key)) return null
                return (
                  <li key={key}>
                    <span>
                      {warning.lineId ? `${warning.lineId}: ` : ''}
                      {warning.message}
                    </span>
                    <button
                      className="text-button"
                      onClick={() => setReviewedWarnings((current) => new Set(current).add(key))}
                    >
                      İncelendi
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p>AI özel bir uyarı üretmedi; yine de tüm metin ve zamanları dinleyerek kontrol et.</p>
          )}
        </section>
      )}
      <div className="studio-workspace">
        <div>
          {sourceUrl && (
            <video
              ref={videoRef}
              className="studio-video"
              src={sourceUrl}
              controls
              preload="metadata"
              onTimeUpdate={(event) => {
                const currentMs = captureVideoTimeMs(
                  event.currentTarget.currentTime,
                  draft.media.durationMs,
                )
                setPlayheadMs(currentMs)
                if (auditionEndRef.current !== null && currentMs >= auditionEndRef.current) {
                  event.currentTarget.pause()
                  auditionEndRef.current = null
                }
              }}
              onSeeked={(event) =>
                setPlayheadMs(
                  captureVideoTimeMs(event.currentTarget.currentTime, draft.media.durationMs),
                )
              }
            />
          )}
          <div className="playhead-readout">
            Oynatma konumu: <strong>{formatTimestamp(playheadMs)}</strong>
          </div>
          <p className="studio-shortcuts">
            Klavye: J/L ±250 ms · K oynat/duraklat · I başlangıcı, O bitişi ayarla
          </p>
          <Timeline
            durationMs={draft.media.durationMs}
            lines={editable.lines}
            characters={editable.characters}
            playheadMs={playheadMs}
            onSelect={setSelectedLineId}
            onReassign={(lineId, characterId) => updateLine(lineId, { characterId })}
            selected={selectedLineId}
          />
          {preview && (
            <div className="studio-subtitles" aria-live="polite">
              {activeLines.map((line) => (
                <p key={line.id}>
                  <strong>
                    {
                      editable.characters.find((character) => character.id === line.characterId)
                        ?.name
                    }
                    :
                  </strong>{' '}
                  {line.text}
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="studio-editor">
          <label>
            Sahne başlığı
            <input
              value={editable.title}
              maxLength={100}
              onChange={(event) => setEditable({ ...editable, title: event.target.value })}
            />
          </label>
          <label>
            Açıklama (isteğe bağlı)
            <textarea
              value={editable.description}
              maxLength={1000}
              onChange={(event) => setEditable({ ...editable, description: event.target.value })}
            />
          </label>
          <div className="editor-section">
            <div className="editor-title">
              <h2>Karakterler</h2>
              <button className="button button-secondary" onClick={addCharacter}>
                Karakter ekle
              </button>
            </div>
            {editable.characters.map((character) => (
              <div className="character-row" key={character.id}>
                <input
                  aria-label="Karakter adı"
                  value={character.name}
                  onChange={(event) =>
                    setEditable((current) => ({
                      ...current,
                      characters: current.characters.map((entry) =>
                        entry.id === character.id ? { ...entry, name: event.target.value } : entry,
                      ),
                    }))
                  }
                />
                <small>{lineCounts[character.id] ?? 0} replik</small>
                <button
                  className="text-button danger"
                  onClick={() => removeCharacter(character.id)}
                >
                  Sil
                </button>
              </div>
            ))}
          </div>
          <div className="editor-section">
            <div className="editor-title">
              <h2>Replikler</h2>
              <button className="button button-secondary" onClick={addLine}>
                Replik ekle
              </button>
            </div>
            <div className="transcript-toolbar" aria-label="Replik gezinme araçları">
              <button className="text-button" onClick={() => navigateLines(-1)}>
                ← Önceki
              </button>
              <button className="text-button" onClick={() => navigateLines(1)}>
                Sonraki →
              </button>
              <button className="text-button" onClick={() => navigateLines(-1, true)}>
                ← Önceki uyarı
              </button>
              <button className="text-button" onClick={() => navigateLines(1, true)}>
                Sonraki uyarı →
              </button>
              <label className="warning-filter">
                <input
                  type="checkbox"
                  checked={onlyWarnings}
                  onChange={(event) => setOnlyWarnings(event.target.checked)}
                />
                Yalnızca kontrol edilmesi gerekenler
              </label>
            </div>
            <div
              className="transcript-list"
              ref={transcriptRef}
              aria-label="Kompakt replik listesi"
            >
              {visibleLines.map((line) => {
                const characterIndex = Math.max(
                  0,
                  editable.characters.findIndex((entry) => entry.id === line.characterId),
                )
                const character = editable.characters[characterIndex]
                const warningCodes = warningCodesByLine[line.id] ?? []
                return (
                  <button
                    type="button"
                    className={`transcript-row ${selectedLineId === line.id ? 'selected' : ''} ${warningCodes.length ? 'ai-needs-review' : ''}`}
                    data-line-id={line.id}
                    key={line.id}
                    onClick={() => setSelectedLineId(line.id)}
                    style={{ '--speaker-color': speakerColor(characterIndex) } as CSSProperties}
                  >
                    <span className="speaker-dot" aria-hidden="true" />
                    <span className="transcript-copy">
                      <strong>{character?.name ?? 'Karakter seçilmedi'}</strong>
                      <span>{line.text || 'Boş replik'}</span>
                    </span>
                    <span className="transcript-meta">
                      {formatTimestamp(line.startMs)}–{formatTimestamp(line.endMs)}
                      {warningCodes.length > 0 && (
                        <span title={warningLabels(warningCodes)}>⚠ Kontrol et</span>
                      )}
                    </span>
                  </button>
                )
              })}
              {onlyWarnings && visibleLines.length === 0 && <p>Kontrol bekleyen replik yok.</p>}
            </div>
            {selectedLine && (
              <div
                className="line-editor selected"
                style={
                  {
                    '--speaker-color': speakerColor(
                      Math.max(
                        0,
                        editable.characters.findIndex(
                          (entry) => entry.id === selectedLine.characterId,
                        ),
                      ),
                    ),
                  } as CSSProperties
                }
              >
                <div className="selected-line-heading">
                  <strong>Seçili repliği düzelt</strong>
                  <span>
                    {orderedLines.findIndex((line) => line.id === selectedLine.id) + 1}/
                    {orderedLines.length}
                  </span>
                </div>
                <div className="speaker-quick-actions" aria-label="Hızlı konuşmacı atama">
                  {editable.characters.map((character, index) => (
                    <button
                      type="button"
                      className={character.id === selectedLine.characterId ? 'active' : ''}
                      key={character.id}
                      onClick={() => updateLine(selectedLine.id, { characterId: character.id })}
                      style={{ '--speaker-color': speakerColor(index) } as CSSProperties}
                    >
                      <span className="speaker-dot" aria-hidden="true" /> {character.name}
                    </button>
                  ))}
                  <button type="button" onClick={addAndAssignSpeaker}>
                    + Yeni konuşmacı oluştur ve ata
                  </button>
                </div>
                <label>
                  Replik metni
                  <textarea
                    ref={transcriptTextRef}
                    aria-label="Replik metni"
                    placeholder="Söylenecek replik"
                    value={selectedLine.text}
                    onChange={(event) => updateLine(selectedLine.id, { text: event.target.value })}
                  />
                  <small>
                    Bölmeden önce imleci iki konuşmacının metni arasına getir; imleç yoksa oynatma
                    konumuna göre en yakın boşluk seçilir.
                  </small>
                </label>
                {(warningCodesByLine[selectedLine.id]?.length ?? 0) > 0 && (
                  <div className="selected-warning-list">
                    {(warningCodesByLine[selectedLine.id] ?? []).map((code) => (
                      <span key={code}>⚠ {warningLabel(code)}</span>
                    ))}
                  </div>
                )}
                <div className="time-inputs">
                  <BoundaryEditor
                    label="Başlangıç"
                    valueMs={selectedLine.startMs}
                    onChange={(value) => updateLine(selectedLine.id, { startMs: value })}
                    onCapture={() => capture('startMs')}
                    onNudge={(delta) =>
                      setEditable((current) =>
                        nudgeDialogueBoundary(
                          current,
                          selectedLine.id,
                          'startMs',
                          delta,
                          draft.media.durationMs,
                        ),
                      )
                    }
                  />
                  <BoundaryEditor
                    label="Bitiş"
                    valueMs={selectedLine.endMs}
                    onChange={(value) => updateLine(selectedLine.id, { endMs: value })}
                    onCapture={() => capture('endMs')}
                    onNudge={(delta) =>
                      setEditable((current) =>
                        nudgeDialogueBoundary(
                          current,
                          selectedLine.id,
                          'endMs',
                          delta,
                          draft.media.durationMs,
                        ),
                      )
                    }
                  />
                </div>
                <div className="line-actions">
                  <button className="text-button" onClick={auditionSelectedLine}>
                    Repliği oynat
                  </button>
                  <button className="text-button" onClick={splitSelectedLine}>
                    Repliği burada böl
                  </button>
                  <button className="text-button" onClick={mergeSelectedLine}>
                    Sonraki replikle birleştir
                  </button>
                  <button
                    className="text-button danger"
                    onClick={() => {
                      setEditable((current) => deleteDialogueLine(current, selectedLine.id))
                      setSelectedLineId(null)
                    }}
                  >
                    Repliği sil
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <section className="studio-validation">
        <span className="eyebrow">Doğrulama ve ön izleme</span>
        <h2>{validation.length ? 'Sahne henüz hazır değil' : 'Sahne oynanmaya hazır'}</h2>
        <p>
          {formatTimestamp(draft.media.durationMs)} · {editable.characters.length} karakter ·{' '}
          {editable.lines.length} replik
        </p>
        {validation.length > 0 && (
          <ul>
            {validation.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <button
          className="button button-secondary"
          disabled={validation.length > 0}
          onClick={() => setPreview((value) => !value)}
        >
          {preview ? 'Ön izlemeyi kapat' : 'Zamanlı replikleri ön izle'}
        </button>
        <button
          className="button button-primary"
          disabled={validation.length > 0 || busy}
          onClick={() => void save()}
        >
          {busy
            ? 'Kaydediliyor…'
            : draft.status === 'prepared'
              ? 'Düzeltmeleri yeni sürüm olarak kaydet'
              : 'Oynanabilir özel sahne olarak kaydet'}
        </button>
      </section>
      {error && (
        <p className="room-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function MediaFacts({
  media,
}: {
  media: Pick<
    UploadedMedia,
    'filename' | 'durationMs' | 'byteSize' | 'width' | 'height' | 'mimeType'
  >
}) {
  return (
    <dl className="media-facts">
      <div>
        <dt>Dosya</dt>
        <dd>{media.filename}</dd>
      </div>
      <div>
        <dt>Süre</dt>
        <dd>{formatTimestamp(media.durationMs)}</dd>
      </div>
      <div>
        <dt>Boyut</dt>
        <dd>{(media.byteSize / 1024 / 1024).toFixed(2)} MB</dd>
      </div>
      <div>
        <dt>Görüntü</dt>
        <dd>
          {media.width}×{media.height}
        </dd>
      </div>
      <div>
        <dt>Tür</dt>
        <dd>{media.mimeType}</dd>
      </div>
    </dl>
  )
}

function Timeline({
  durationMs,
  lines,
  characters,
  playheadMs,
  onSelect,
  onReassign,
  selected,
}: {
  durationMs: number
  lines: DialogueLine[]
  characters: EditableScene['characters']
  playheadMs: number
  onSelect(id: string): void
  onReassign(lineId: string, characterId: string): void
  selected: string | null
}) {
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    lineId: string
    pointerId: number
    startX: number
    startY: number
    dragging: boolean
    targetCharacterId: string | null
  } | null>(null)
  const [dragVisual, setDragVisual] = useState<{
    lineId: string
    dragging: boolean
    targetCharacterId: string | null
  } | null>(null)

  function targetCharacter(event: PointerEvent<HTMLButtonElement>) {
    const bounds = timelineRef.current?.getBoundingClientRect()
    if (
      !bounds ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top + 8 ||
      event.clientY >= bounds.top + 8 + characters.length * 24
    )
      return null
    return characters[Math.floor((event.clientY - bounds.top - 8) / 24)]?.id ?? null
  }

  function beginDrag(event: PointerEvent<HTMLButtonElement>, lineId: string) {
    if (event.button !== 0) return
    onSelect(lineId)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      lineId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      targetCharacterId: null,
    }
    setDragVisual({ lineId, dragging: false, targetCharacterId: null })
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6
    if (!drag.dragging && !moved) return
    event.preventDefault()
    drag.dragging = true
    drag.targetCharacterId = targetCharacter(event)
    setDragVisual({
      lineId: drag.lineId,
      dragging: true,
      targetCharacterId: drag.targetCharacterId,
    })
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.dragging) {
      const target = targetCharacter(event)
      if (target) onReassign(drag.lineId, target)
      event.preventDefault()
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    dragRef.current = null
    setDragVisual(null)
  }

  const timelineHeight = Math.max(112, 16 + characters.length * 24)
  return (
    <div
      ref={timelineRef}
      className="studio-timeline"
      aria-label="Replik zaman çizelgesi"
      style={{ height: `${timelineHeight}px` }}
    >
      {characters.map((character, index) => (
        <div
          key={character.id}
          aria-label={`${character.name} konuşmacı şeridi`}
          className={`studio-speaker-lane ${dragVisual?.targetCharacterId === character.id ? 'is-drop-target' : ''}`}
          data-character-id={character.id}
          style={
            {
              top: `${8 + index * 24}px`,
              '--speaker-color': speakerColor(index),
            } as CSSProperties
          }
        />
      ))}
      <i className="studio-playhead" style={{ left: `${(playheadMs / durationMs) * 100}%` }} />
      {lines.map((line) => {
        const characterIndex = Math.max(
          0,
          characters.findIndex((entry) => entry.id === line.characterId),
        )
        return (
          <button
            key={line.id}
            aria-label={`${characters[characterIndex]?.name ?? 'Karakter'}: ${line.text}`}
            title={`${characters[characterIndex]?.name ?? 'Karakter'}: ${line.text}`}
            className={`${selected === line.id ? 'selected' : ''} ${dragVisual?.lineId === line.id && dragVisual.dragging ? 'dragging' : ''}`}
            style={
              {
                left: `${(line.startMs / durationMs) * 100}%`,
                width: `${Math.max(0.5, ((line.endMs - line.startMs) / durationMs) * 100)}%`,
                top: `${10 + characterIndex * 24}px`,
                '--speaker-color': speakerColor(characterIndex),
              } as CSSProperties
            }
            onClick={() => onSelect(line.id)}
            onPointerDown={(event) => beginDrag(event, line.id)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={() => {
              dragRef.current = null
              setDragVisual(null)
            }}
          />
        )
      })}
    </div>
  )
}

function BoundaryEditor({
  label,
  valueMs,
  onChange,
  onCapture,
  onNudge,
}: {
  label: string
  valueMs: number
  onChange(valueMs: number): void
  onCapture(): void
  onNudge(deltaMs: number): void
}) {
  return (
    <fieldset className="boundary-editor">
      <legend>{label}</legend>
      <input
        aria-label={`${label} (sn)`}
        type="number"
        min="0"
        step="0.001"
        value={(valueMs / 1000).toFixed(3)}
        onChange={(event) => onChange(Math.round(Number(event.target.value) * 1000))}
      />
      <button className="text-button" onClick={onCapture}>
        {label === 'Başlangıç' ? 'Başlangıcı buraya ayarla' : 'Bitişi buraya ayarla'}
      </button>
      <div className="nudge-actions" aria-label={`${label} zamanını düzelt`}>
        {nudgeValues.map((delta) => (
          <button type="button" key={delta} onClick={() => onNudge(delta)}>
            {delta > 0 ? '+' : ''}
            {delta} ms
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function speakerColor(index: number) {
  return speakerColors[index % speakerColors.length]
}

function warningLabel(code: string) {
  return (
    {
      uncertain_speaker: 'Konuşmacı belirsiz',
      overlapping_speech: 'Üst üste konuşma',
      low_transcription_confidence: 'Düşük transkripsiyon güveni',
      timing_review: 'Zamanlama kontrol edilmeli',
      speaker_stabilization_failed: 'Konuşmacı sabitleme kontrol edilmeli',
      very_short_line: 'Çok kısa replik',
      speech_not_detected: 'Konuşma algılanamadı',
    }[code] ?? code
  )
}

function warningLabels(codes: string[]) {
  return codes.map(warningLabel).join(' · ')
}

function splitAiAnalysis(
  analysis: AiAnalysis,
  lineId: string,
  newLineId: string,
  splitMs: number,
): AiAnalysis {
  const source = analysis.lineAnalysis.find((entry) => entry.lineId === lineId)
  return {
    ...analysis,
    lineAnalysis: source
      ? [
          ...analysis.lineAnalysis,
          { ...source, lineId: newLineId, warningCodes: [...source.warningCodes] },
        ]
      : analysis.lineAnalysis,
    warnings: analysis.warnings.flatMap((warning) =>
      warning.lineId === lineId
        ? [
            { ...warning, endMs: splitMs },
            { ...warning, lineId: newLineId, startMs: splitMs },
          ]
        : [warning],
    ),
  }
}

function mergeAiAnalysis(analysis: AiAnalysis, lineId: string, removedLineId: string): AiAnalysis {
  const kept = analysis.lineAnalysis.find((entry) => entry.lineId === lineId)
  const removed = analysis.lineAnalysis.find((entry) => entry.lineId === removedLineId)
  const warningCodes = [
    ...new Set([...(kept?.warningCodes ?? []), ...(removed?.warningCodes ?? [])]),
  ]
  return {
    ...analysis,
    lineAnalysis: analysis.lineAnalysis
      .filter((entry) => entry.lineId !== removedLineId)
      .map((entry) => (entry.lineId === lineId ? { ...entry, warningCodes } : entry)),
    warnings: analysis.warnings.map((warning) =>
      warning.lineId === removedLineId ? { ...warning, lineId } : warning,
    ),
  }
}

function stableId(prefix: string, used: string[]) {
  let index = used.length + 1
  while (used.includes(`${prefix}-${index}`)) index++
  return `${prefix}-${index}`
}
function message(value: unknown) {
  return value instanceof Error ? value.message : 'İşlem tamamlanamadı.'
}

function pollingDelay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, 750)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout)
        reject(new DOMException('İptal edildi.', 'AbortError'))
      },
      { once: true },
    )
  })
}
