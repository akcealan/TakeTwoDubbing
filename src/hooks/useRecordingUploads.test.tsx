import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalLineRecording } from '../lib/recording/localRecording'
import { uploadLineRecording } from '../lib/api/rooms'
import { useRecordingUploads } from './useRecordingUploads'

vi.mock('../lib/api/rooms', () => ({ uploadLineRecording: vi.fn() }))

const session = {
  code: '012345',
  roomId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002',
  token: 'a'.repeat(64),
}
const recording: LocalLineRecording = {
  recordingId: '00000000-0000-4000-8000-000000000003',
  lineId: 'step-1',
  playerId: session.playerId,
  startMs: 1000,
  endMs: 4500,
  captureStartMs: 500,
  captureEndMs: 5000,
  durationMs: 1200,
  mimeType: 'audio/webm;codecs=opus',
  blob: new Blob(['local voice']),
  objectUrl: 'blob:local-voice',
}

function Harness() {
  const uploads = useRecordingUploads(session)
  const state = uploads.states.get(recording.lineId)
  return (
    <div>
      <output data-testid="status">{state?.status ?? 'waiting'}</output>
      {state?.error && <p role="alert">{state.error}</p>}
      <button onClick={() => void uploads.upload(recording)}>upload</button>
    </div>
  )
}

describe('useRecordingUploads', () => {
  beforeEach(() => vi.mocked(uploadLineRecording).mockReset())

  it('keeps the local recording retryable after failure and marks a retry uploaded', async () => {
    vi.mocked(uploadLineRecording)
      .mockRejectedValueOnce(new Error('Bağlantı kurulamadı; yerel kayıt duruyor.'))
      .mockResolvedValueOnce({
        recordingId: recording.recordingId,
        lineId: recording.lineId,
        playerId: recording.playerId,
        mimeType: 'audio/webm;codecs=opus',
        byteSize: recording.blob.size,
        durationMs: recording.durationMs,
        uploadedAt: 1234,
      })
    render(<Harness />)
    fireEvent.click(screen.getByText('upload'))
    expect(await screen.findByRole('alert')).toHaveTextContent('yerel kayıt duruyor')
    expect(screen.getByTestId('status')).toHaveTextContent('error')
    expect(recording.blob.size).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('upload'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('uploaded'))
    expect(uploadLineRecording).toHaveBeenCalledTimes(2)
    expect(uploadLineRecording).toHaveBeenLastCalledWith(session, recording)
  })
})
