import { useCallback, useRef, useState } from 'react'
import type { RoomSession } from '../../shared/schemas/protocol'
import type { LocalLineRecording } from '../lib/recording/localRecording'
import { uploadLineRecording } from '../lib/api/rooms'

export type RecordingUploadStatus = 'waiting' | 'uploading' | 'uploaded' | 'error'

interface UploadState {
  recordingId: string
  status: RecordingUploadStatus
  error: string | null
}

export function useRecordingUploads(session: RoomSession) {
  const [states, setStates] = useState<ReadonlyMap<string, UploadState>>(() => new Map())
  const activeRef = useRef(new Set<string>())

  const upload = useCallback(
    async (recording: LocalLineRecording) => {
      if (activeRef.current.has(recording.lineId)) return false
      activeRef.current.add(recording.lineId)
      setStates((current) => {
        const next = new Map(current)
        next.set(recording.lineId, {
          recordingId: recording.recordingId,
          status: 'uploading',
          error: null,
        })
        return next
      })
      try {
        const stored = await uploadLineRecording(session, recording)
        setStates((current) => {
          const next = new Map(current)
          next.set(recording.lineId, {
            recordingId: stored.recordingId,
            status: 'uploaded',
            error: null,
          })
          return next
        })
        return true
      } catch (error) {
        setStates((current) => {
          const next = new Map(current)
          next.set(recording.lineId, {
            recordingId: recording.recordingId,
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Kayıt yüklenemedi. Yerel kayıt duruyor; tekrar dene.',
          })
          return next
        })
        return false
      } finally {
        activeRef.current.delete(recording.lineId)
      }
    },
    [session],
  )

  return { states, upload }
}
