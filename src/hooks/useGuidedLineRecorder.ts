import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DialogueLine } from '../../shared/types'
import {
  isOwnedLine,
  microphoneErrorMessage,
  selectSupportedRecorderMimeType,
  type LocalLineRecording,
} from '../lib/recording/localRecording'
import { getRecordingCaptureWindow } from '../../shared/recordingTiming'

export type GuidedRecorderPhase = 'idle' | 'preparing' | 'armed' | 'recording' | 'preview' | 'error'

function releaseStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

export function useGuidedLineRecorder(
  playerId: string,
  ownedLines: readonly DialogueLine[],
  sceneDurationMs: number,
) {
  const ownedIds = useMemo(() => new Set(ownedLines.map((line) => line.id)), [ownedLines])
  const [phase, setPhase] = useState<GuidedRecorderPhase>('idle')
  const [draft, setDraft] = useState<LocalLineRecording | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const lineRef = useRef<DialogueLine | null>(null)
  const draftRef = useRef<LocalLineRecording | null>(null)
  const operationRef = useRef(0)
  const mountedRef = useRef(true)

  const discardDraft = useCallback(() => {
    if (draftRef.current) URL.revokeObjectURL(draftRef.current.objectUrl)
    draftRef.current = null
    setDraft(null)
  }, [])

  const abort = useCallback(() => {
    operationRef.current += 1
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder?.state === 'recording') recorder.stop()
    releaseStream(streamRef.current)
    streamRef.current = null
    chunksRef.current = []
    lineRef.current = null
    setPhase('idle')
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abort()
      if (draftRef.current) URL.revokeObjectURL(draftRef.current.objectUrl)
    }
  }, [abort])

  const fail = useCallback((message: string) => {
    releaseStream(streamRef.current)
    streamRef.current = null
    recorderRef.current = null
    setError(message)
    setPhase('error')
  }, [])

  const prepare = useCallback(
    async (line: DialogueLine) => {
      if (!isOwnedLine(line, ownedIds) || phase === 'preparing' || phase === 'recording')
        return false
      const Recorder = globalThis.MediaRecorder
      const mimeType = selectSupportedRecorderMimeType(Recorder)
      if (!navigator.mediaDevices?.getUserMedia || !Recorder || !mimeType) {
        fail('Bu tarayıcı mikrofon kaydını desteklemiyor. Güncel bir tarayıcıyla tekrar dene.')
        return false
      }
      const operation = ++operationRef.current
      discardDraft()
      setError(null)
      setPhase('preparing')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (operation !== operationRef.current || !mountedRef.current) {
          releaseStream(stream)
          return false
        }
        const recorder = new Recorder(stream, { mimeType })
        streamRef.current = stream
        recorderRef.current = recorder
        chunksRef.current = []
        lineRef.current = line
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data)
        }
        recorder.onerror = () =>
          fail('Kayıt sırasında bir cihaz hatası oluştu. Mikrofonunu kontrol edip tekrar dene.')
        recorder.onstop = () => {
          releaseStream(streamRef.current)
          streamRef.current = null
          recorderRef.current = null
          if (operation !== operationRef.current || !mountedRef.current) return
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType })
          chunksRef.current = []
          if (blob.size === 0) {
            fail('Kayıt boş oluştu. Mikrofonunu kontrol edip yeniden kaydet.')
            return
          }
          const capture = getRecordingCaptureWindow(line, sceneDurationMs)
          const recording: LocalLineRecording = {
            recordingId: crypto.randomUUID(),
            lineId: line.id,
            playerId,
            startMs: line.startMs,
            endMs: line.endMs,
            ...capture,
            durationMs: capture.captureEndMs - capture.captureStartMs,
            mimeType: recorder.mimeType || mimeType,
            blob,
            objectUrl: URL.createObjectURL(blob),
          }
          draftRef.current = recording
          setDraft(recording)
          setPhase('preview')
        }
        setPhase('armed')
        return true
      } catch (reason) {
        if (operation === operationRef.current) fail(microphoneErrorMessage(reason))
        return false
      }
    },
    [discardDraft, fail, ownedIds, phase, playerId, sceneDurationMs],
  )

  const beginAtCaptureStart = useCallback(
    (line: DialogueLine) => {
      const recorder = recorderRef.current
      if (lineRef.current?.id !== line.id || !recorder || recorder.state !== 'inactive')
        return false
      try {
        recorder.start()
        setPhase('recording')
        return true
      } catch {
        fail('Kayıt başlatılamadı. Mikrofonunu kontrol edip tekrar dene.')
        return false
      }
    },
    [fail],
  )

  const stopAtCaptureEnd = useCallback(
    (line: DialogueLine) => {
      const recorder = recorderRef.current
      if (lineRef.current?.id !== line.id || !recorder || recorder.state !== 'recording')
        return false
      try {
        recorder.stop()
        return true
      } catch {
        fail('Kayıt otomatik olarak durdurulamadı. Repliği yeniden deneyebilirsin.')
        return false
      }
    },
    [fail],
  )

  return {
    phase,
    draft,
    error,
    prepare,
    beginAtCaptureStart,
    stopAtCaptureEnd,
    discardDraft,
    abort,
  }
}
