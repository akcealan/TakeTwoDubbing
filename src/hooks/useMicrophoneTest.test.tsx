import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMicrophoneTest } from './useMicrophoneTest'

const stopTrack = vi.fn()
const close = vi.fn(async () => undefined)
const createObjectURL = vi.fn()

class TestAudioContext {
  state: AudioContextState = 'running'
  createAnalyser() {
    return {
      fftSize: 8,
      smoothingTimeConstant: 0,
      getByteTimeDomainData: (data: Uint8Array) => data.fill(150),
    } as unknown as AnalyserNode
  }
  createMediaStreamSource() {
    return { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode
  }
  close = close
}

function Harness() {
  const microphone = useMicrophoneTest()
  return (
    <>
      <output>{microphone.message}</output>
      <output data-testid="level">{microphone.level}</output>
      {microphone.error && <p role="alert">{microphone.error}</p>}
      <button onClick={() => void microphone.start()}>başlat</button>
      <button onClick={microphone.stop}>bitir</button>
    </>
  )
}

describe('useMicrophoneTest', () => {
  beforeEach(() => {
    stopTrack.mockClear()
    close.mockClear()
    vi.stubGlobal('AudioContext', TestAudioContext as unknown as typeof AudioContext)
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
      value: createObjectURL,
    })
    createObjectURL.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows live analyser input and releases test-only resources', async () => {
    render(<Harness />)
    expect(screen.getByText('Mikrofon bekleniyor')).toBeInTheDocument()
    fireEvent.click(screen.getByText('başlat'))
    await waitFor(() => expect(screen.getByText('Sesin geliyor')).toBeInTheDocument())
    expect(Number(screen.getByTestId('level').textContent)).toBeGreaterThan(0)
    act(() => fireEvent.click(screen.getByText('bitir')))
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports permission denial without storing test audio', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new DOMException('denied', 'NotAllowedError'),
    )
    render(<Harness />)
    fireEvent.click(screen.getByText('başlat'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Mikrofon izni verilmedi')
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
