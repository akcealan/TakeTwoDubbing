import { useCallback, useEffect, useRef, useState } from 'react'
import { microphoneErrorMessage } from '../lib/recording/localRecording'

export type MicrophoneTestPhase = 'idle' | 'requesting' | 'listening' | 'error'

function releaseStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

export function useMicrophoneTest() {
  const [phase, setPhase] = useState<MicrophoneTestPhase>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const frameRef = useRef(0)
  const operationRef = useRef(0)

  const stop = useCallback(() => {
    operationRef.current += 1
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    releaseStream(streamRef.current)
    streamRef.current = null
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') void context.close()
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    if (phase === 'requesting' || phase === 'listening') return false
    const AudioContextConstructor =
      globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextConstructor) {
      setPhase('error')
      setError(
        'Bu tarayıcı canlı mikrofon testini desteklemiyor. Güncel bir tarayıcıyla tekrar dene.',
      )
      return false
    }

    const operation = ++operationRef.current
    setPhase('requesting')
    setError(null)
    setLevel(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (operation !== operationRef.current) {
        releaseStream(stream)
        return false
      }
      const context = new AudioContextConstructor()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      streamRef.current = stream
      contextRef.current = context
      setPhase('listening')

      const measure = () => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) {
          const normalized = (sample - 128) / 128
          sum += normalized * normalized
        }
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4))
        frameRef.current = requestAnimationFrame(measure)
      }
      frameRef.current = requestAnimationFrame(measure)
      return true
    } catch (reason) {
      if (operation === operationRef.current) {
        setPhase('error')
        setError(microphoneErrorMessage(reason))
      }
      return false
    }
  }, [phase])

  const message =
    phase === 'requesting'
      ? 'Mikrofon bekleniyor'
      : phase === 'listening'
        ? level >= 0.08
          ? 'Sesin geliyor'
          : level > 0.01
            ? 'Ses seviyesi çok düşük'
            : 'Bir şeyler söyle'
        : phase === 'error'
          ? 'Mikrofon kullanılamadı'
          : 'Mikrofon bekleniyor'

  return { phase, level, error, message, start, stop, ready: phase === 'listening' }
}
