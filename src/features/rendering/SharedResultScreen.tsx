import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { RoomSession } from '../../../shared/schemas/protocol'
import type { Room, Scene } from '../../../shared/types'
import { fetchSharedResult } from '../../lib/api/rooms'

export function SharedResultScreen({
  room,
  session,
  scene,
}: {
  room: Room
  session: RoomSession
  scene: Scene
}) {
  const result = room.result
  const urlRef = useRef<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    url?: string
    error?: string
  }>({ status: 'loading' })

  useEffect(() => {
    if (!result) return
    const controller = new AbortController()
    void fetchSharedResult(session, result, controller.signal)
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        urlRef.current = url
        setState({ status: 'ready', url })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            error: error instanceof Error ? error.message : 'Video alınamadı.',
          })
      })
    return () => {
      controller.abort()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [result, session])

  if (!result)
    return (
      <section className="empty-page">
        <h1>Oda sonucu bulunamadı.</h1>
      </section>
    )

  return (
    <section className="playback-page shared-result-page">
      <header className="playback-heading">
        <div>
          <span className="eyebrow">Dublaj tamamlandı</span>
          <h1>{scene.title}</h1>
          <p>Odanın ortak final videosu hazır.</p>
        </div>
        <span className="status-pill is-online">Bitti</span>
      </header>
      <section className="render-panel" aria-labelledby="shared-result-title">
        <h2 id="shared-result-title">Final dublajı</h2>
        {state.status === 'loading' && (
          <p role="status">Paylaşılan video güvenli depodan alınıyor…</p>
        )}
        {state.status === 'error' && (
          <p className="render-error" role="alert">
            {state.error}
          </p>
        )}
        {state.status === 'ready' && state.url && (
          <div className="render-result">
            <video ref={videoRef} src={state.url} controls playsInline preload="metadata">
              Tarayıcın video oynatmayı desteklemiyor.
            </video>
            <div className="render-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => {
                  if (!videoRef.current) return
                  videoRef.current.currentTime = 0
                  void videoRef.current.play()
                }}
              >
                Baştan Oynat
              </button>
              <a className="button button-secondary" href={state.url} download={result.filename}>
                MP4'ü İndir
              </a>
              <Link className="button button-secondary" to="/">
                Yeni Oyun
              </Link>
            </div>
          </div>
        )}
      </section>
    </section>
  )
}
