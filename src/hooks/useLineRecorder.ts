import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DialogueLine } from '../../shared/types'
import {
  isOwnedLine,
  microphoneErrorMessage,
  selectSupportedRecorderMimeType,
  type LocalLineRecording,
} from '../lib/recording/localRecording'

export type RecordingPhase =
  'idle' | 'requesting-permission' | 'ready' | 'recording' | 'preview' | 'accepted' | 'error'

interface RecorderViewState {
  phase: RecordingPhase
  selectedLineId: string | null
  draft: LocalLineRecording | null
  error: string | null
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

export function useLineRecorder(playerId: string, ownedLines: readonly DialogueLine[]) {
  const ownedLineIds = useMemo(() => new Set(ownedLines.map((line) => line.id)), [ownedLines])
  const [view, setView] = useState<RecorderViewState>(() => ({
    phase: 'idle',
    selectedLineId: ownedLines[0]?.id ?? null,
    draft: null,
    error: null,
  }))
  const [acceptedRecordings, setAcceptedRecordings] = useState<
    ReadonlyMap<string, LocalLineRecording>
  >(() => new Map())
  const acceptedRef = useRef(new Map<string, LocalLineRecording>())
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordingStartedAtRef = useRef(0)
  const operationRef = useRef(0)
  const mountedRef = useRef(true)
  const phaseRef = useRef<RecordingPhase>('idle')
  const draftRef = useRef<LocalLineRecording | null>(null)

  const updateView = useCallback((next: RecorderViewState) => {
    phaseRef.current = next.phase
    draftRef.current = next.draft
    setView(next)
  }, [])

  const revokeDraft = useCallback(() => {
    const draft = draftRef.current
    if (draft) URL.revokeObjectURL(draft.objectUrl)
    draftRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current += 1
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      stopStream(streamRef.current)
      const draft = draftRef.current
      if (draft) URL.revokeObjectURL(draft.objectUrl)
      acceptedRef.current.forEach((recording) => URL.revokeObjectURL(recording.objectUrl))
    }
  }, [])

  const fail = useCallback(
    (message: string) => {
      operationRef.current += 1
      stopStream(streamRef.current)
      streamRef.current = null
      recorderRef.current = null
      updateView({
        phase: 'error',
        selectedLineId: view.selectedLineId,
        draft: draftRef.current,
        error: message,
      })
    },
    [updateView, view.selectedLineId],
  )

  const selectLine = useCallback(
    (lineId: string) => {
      if (!ownedLineIds.has(lineId) || phaseRef.current === 'recording') return false
      operationRef.current += 1
      revokeDraft()
      const accepted = acceptedRef.current.has(lineId)
      updateView({
        phase: accepted ? 'accepted' : 'idle',
        selectedLineId: lineId,
        draft: null,
        error: null,
      })
      return true
    },
    [ownedLineIds, revokeDraft, updateView],
  )

  const start = useCallback(
    async (line: DialogueLine) => {
      if (
        !isOwnedLine(line, ownedLineIds) ||
        phaseRef.current === 'requesting-permission' ||
        phaseRef.current === 'recording'
      )
        return false

      const Recorder = globalThis.MediaRecorder
      const mimeType = selectSupportedRecorderMimeType(Recorder)
      if (!navigator.mediaDevices?.getUserMedia || !Recorder || !mimeType) {
        updateView({
          phase: 'error',
          selectedLineId: line.id,
          draft: draftRef.current,
          error: 'Bu tarayıcı mikrofon kaydını desteklemiyor. Güncel bir tarayıcıyla tekrar dene.',
        })
        return false
      }

      const operation = ++operationRef.current
      revokeDraft()
      updateView({
        phase: 'requesting-permission',
        selectedLineId: line.id,
        draft: null,
        error: null,
      })

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (error) {
        if (operation === operationRef.current && mountedRef.current)
          updateView({
            phase: 'error',
            selectedLineId: line.id,
            draft: null,
            error: microphoneErrorMessage(error),
          })
        return false
      }
      if (operation !== operationRef.current || !mountedRef.current) {
        stopStream(stream)
        return false
      }

      streamRef.current = stream
      chunksRef.current = []
      updateView({ phase: 'ready', selectedLineId: line.id, draft: null, error: null })
      let recorder: MediaRecorder
      try {
        recorder = new Recorder(stream, { mimeType })
        recorderRef.current = recorder
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data)
        }
        recorder.onerror = () => {
          if (operation !== operationRef.current || !mountedRef.current) return
          fail('Kayıt sırasında bir cihaz hatası oluştu. Mikrofonunu kontrol edip tekrar dene.')
        }
        recorder.onstop = () => {
          stopStream(streamRef.current)
          streamRef.current = null
          recorderRef.current = null
          if (operation !== operationRef.current || !mountedRef.current) return
          const actualMimeType = recorder.mimeType || mimeType
          const blob = new Blob(chunksRef.current, { type: actualMimeType })
          chunksRef.current = []
          if (blob.size === 0) {
            updateView({
              phase: 'error',
              selectedLineId: line.id,
              draft: null,
              error: 'Kayıt boş oluştu. Mikrofonunu kontrol edip yeniden kaydet.',
            })
            return
          }
          const recording: LocalLineRecording = {
            recordingId: crypto.randomUUID(),
            lineId: line.id,
            playerId,
            startMs: line.startMs,
            endMs: line.endMs,
            captureStartMs: line.startMs,
            captureEndMs: line.endMs,
            durationMs: Math.max(0, Math.round(performance.now() - recordingStartedAtRef.current)),
            mimeType: actualMimeType,
            blob,
            objectUrl: URL.createObjectURL(blob),
          }
          updateView({
            phase: 'preview',
            selectedLineId: line.id,
            draft: recording,
            error: null,
          })
        }
        recordingStartedAtRef.current = performance.now()
        recorder.start()
        updateView({ phase: 'recording', selectedLineId: line.id, draft: null, error: null })
        return true
      } catch {
        if (operation === operationRef.current && mountedRef.current)
          fail('Kayıt başlatılamadı. Mikrofonunu kontrol edip tekrar dene.')
        else stopStream(stream)
        return false
      }
    },
    [fail, ownedLineIds, playerId, revokeDraft, updateView],
  )

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (phaseRef.current !== 'recording' || !recorder || recorder.state !== 'recording')
      return false
    try {
      recorder.stop()
      return true
    } catch {
      fail('Kayıt durdurulamadı. Mikrofonunu kontrol edip tekrar dene.')
      return false
    }
  }, [fail])

  const accept = useCallback(() => {
    const recording = draftRef.current
    if (!recording || !ownedLineIds.has(recording.lineId) || phaseRef.current !== 'preview')
      return false
    const previous = acceptedRef.current.get(recording.lineId)
    if (previous) URL.revokeObjectURL(previous.objectUrl)
    const next = new Map(acceptedRef.current)
    next.set(recording.lineId, recording)
    acceptedRef.current = next
    draftRef.current = null
    setAcceptedRecordings(next)
    updateView({
      phase: 'accepted',
      selectedLineId: recording.lineId,
      draft: null,
      error: null,
    })
    return true
  }, [ownedLineIds, updateView])

  const reportPreviewError = useCallback(() => {
    updateView({
      phase: 'error',
      selectedLineId: view.selectedLineId,
      draft: draftRef.current,
      error: 'Kayıt önizlemesi oynatılamadı. Yeniden kaydetmeyi deneyebilirsin.',
    })
  }, [updateView, view.selectedLineId])

  const selectedAccepted = view.selectedLineId
    ? (acceptedRecordings.get(view.selectedLineId) ?? null)
    : null

  return {
    ...view,
    acceptedRecordings,
    selectedRecording: view.draft ?? selectedAccepted,
    selectLine,
    start,
    stop,
    accept,
    reportPreviewError,
  }
}
