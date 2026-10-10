import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DialogueLine } from '../../shared/types'
import { useLineRecorder } from './useLineRecorder'

const ownedLine: DialogueLine = {
  id: 'owned-line',
  characterId: 'nova',
  startMs: 1000,
  endMs: 4000,
  text: 'Benim repliğim.',
}
const secondOwnedLine: DialogueLine = {
  id: 'second-line',
  characterId: 'echo',
  startMs: 5000,
  endMs: 8000,
  text: 'İkinci repliğim.',
}
const unownedLine: DialogueLine = {
  id: 'other-line',
  characterId: 'pip',
  startMs: 9000,
  endMs: 11000,
  text: 'Başkasının repliği.',
}

class MockMediaRecorder {
  static isTypeSupported = vi.fn((mimeType: string) => mimeType === 'audio/webm;codecs=opus')
  static instances: MockMediaRecorder[] = []
  readonly mimeType: string
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onstop: ((event: Event) => void) | null = null

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? ''
    MockMediaRecorder.instances.push(this)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

function Harness({ lines = [ownedLine] }: { lines?: DialogueLine[] }) {
  const recorder = useLineRecorder('player-1', lines)
  return (
    <div>
      <output data-testid="phase">{recorder.phase}</output>
      <output data-testid="accepted">{recorder.acceptedRecordings.size}</output>
      <output data-testid="mime">{recorder.selectedRecording?.mimeType ?? ''}</output>
      {recorder.error && <p role="alert">{recorder.error}</p>}
      <button onClick={() => void recorder.start(ownedLine)}>start-owned</button>
      <button onClick={() => void recorder.start(secondOwnedLine)}>start-second</button>
      <button onClick={() => void recorder.start(unownedLine)}>start-unowned</button>
      <button onClick={recorder.stop}>stop</button>
      <button onClick={recorder.accept}>accept</button>
      <button onClick={() => recorder.selectLine(secondOwnedLine.id)}>select-second</button>
    </div>
  )
}

describe('useLineRecorder', () => {
  const trackStop = vi.fn()
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: trackStop }],
  }))
  const createObjectURL = vi.fn(() => `blob:recording-${createObjectURL.mock.calls.length}`)
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    MockMediaRecorder.instances = []
    MockMediaRecorder.isTypeSupported.mockClear()
    trackStop.mockClear()
    getUserMedia.mockClear()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    vi.stubGlobal('MediaRecorder', MockMediaRecorder as unknown as typeof MediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('reports an unsupported browser without requesting microphone permission', async () => {
    vi.stubGlobal('MediaRecorder', undefined)
    render(<Harness />)
    fireEvent.click(screen.getByText('start-owned'))
    expect(await screen.findByRole('alert')).toHaveTextContent('mikrofon kaydını desteklemiyor')
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('reports denied permission truthfully', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    render(<Harness />)
    fireEvent.click(screen.getByText('start-owned'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Mikrofon izni verilmedi')
    expect(screen.getByTestId('phase')).toHaveTextContent('error')
  })

  it('records, stops, creates a preview and accepts local metadata', async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    )
    fireEvent.click(screen.getByText('start-owned'))
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('recording'))
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(MockMediaRecorder.isTypeSupported).toHaveBeenCalledWith('audio/webm;codecs=opus')

    fireEvent.click(screen.getByText('stop'))
    expect(screen.getByTestId('phase')).toHaveTextContent('preview')
    expect(screen.getByTestId('mime')).toHaveTextContent('audio/webm;codecs=opus')
    expect(trackStop).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByText('accept'))
    expect(screen.getByTestId('phase')).toHaveTextContent('accepted')
    expect(screen.getByTestId('accepted')).toHaveTextContent('1')
  })

  it('re-records and revokes the replaced accepted recording URL', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('start-owned'))
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('recording'))
    fireEvent.click(screen.getByText('stop'))
    fireEvent.click(screen.getByText('accept'))
    expect(revokeObjectURL).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('start-owned'))
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('recording'))
    fireEvent.click(screen.getByText('stop'))
    fireEvent.click(screen.getByText('accept'))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:recording-1')
    expect(screen.getByTestId('accepted')).toHaveTextContent('1')
  })

  it('rejects unowned lines and supports lines from multiple assigned characters', async () => {
    render(<Harness lines={[ownedLine, secondOwnedLine]} />)
    fireEvent.click(screen.getByText('start-unowned'))
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(screen.getByTestId('phase')).toHaveTextContent('idle')

    fireEvent.click(screen.getByText('select-second'))
    fireEvent.click(screen.getByText('start-second'))
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('recording'))
    expect(getUserMedia).toHaveBeenCalledOnce()
  })

  it('revokes accepted object URLs when the recorder leaves the page', async () => {
    const view = render(<Harness />)
    fireEvent.click(screen.getByText('start-owned'))
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('recording'))
    fireEvent.click(screen.getByText('stop'))
    fireEvent.click(screen.getByText('accept'))
    act(() => view.unmount())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:recording-1')
  })
})
