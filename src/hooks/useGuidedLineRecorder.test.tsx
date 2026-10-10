import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DialogueLine } from '../../shared/types'
import { useGuidedLineRecorder } from './useGuidedLineRecorder'

const line: DialogueLine = {
  id: 'line-one',
  characterId: 'nova',
  startMs: 1_000,
  endMs: 4_500,
  text: 'Replik',
}
const stopTrack = vi.fn()

class RecorderMock {
  static isTypeSupported = () => true
  state: RecordingState = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice']) } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

function Harness() {
  const recorder = useGuidedLineRecorder('player', [line], 10_000)
  return (
    <>
      <output data-testid="phase">{recorder.phase}</output>
      <output data-testid="duration">{recorder.draft?.durationMs}</output>
      <output data-testid="capture-start">{recorder.draft?.captureStartMs}</output>
      <output data-testid="capture-end">{recorder.draft?.captureEndMs}</output>
      <button onClick={() => void recorder.prepare(line)}>hazırla</button>
      <button onClick={() => recorder.beginAtCaptureStart(line)}>yakalamayı başlat</button>
      <button onClick={() => recorder.stopAtCaptureEnd(line)}>yakalamayı bitir</button>
      <button onClick={recorder.discardDraft}>çekimi sil</button>
    </>
  )
}

describe('useGuidedLineRecorder', () => {
  beforeEach(() => {
    stopTrack.mockClear()
    vi.stubGlobal('MediaRecorder', RecorderMock as unknown as typeof MediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(
          async () => ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream,
        ),
      },
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:take'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('arms first, records only on capture clock commands, then exposes grace-window metadata', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('hazırla'))
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('armed'))
    fireEvent.click(screen.getByText('yakalamayı başlat'))
    expect(screen.getByTestId('phase')).toHaveTextContent('recording')
    fireEvent.click(screen.getByText('yakalamayı bitir'))
    expect(screen.getByTestId('phase')).toHaveTextContent('preview')
    expect(screen.getByTestId('capture-start')).toHaveTextContent('500')
    expect(screen.getByTestId('capture-end')).toHaveTextContent('5000')
    expect(screen.getByTestId('duration')).toHaveTextContent('4500')
    expect(stopTrack).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('çekimi sil'))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:take')
  })
})
