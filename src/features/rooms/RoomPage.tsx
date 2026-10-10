import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { roomCodeSchema } from '../../../shared/schemas/room'
import type { RoomSession } from '../../../shared/schemas/protocol'
import { loadSession, clearSession, isSessionSaved } from '../../lib/rooms/session'
import { useRoom } from '../../hooks/useRoom'
import { RoomEntry } from './RoomEntry'
import { Lobby } from '../lobby/Lobby'
import { PlaybackScreen } from '../playback/PlaybackScreen'
import { SharedResultScreen } from '../rendering/SharedResultScreen'
import { resolveRoomScene } from '../../../shared/scenes/catalog'

export function RoomPage() {
  const { code } = useParams()
  if (!roomCodeSchema.safeParse(code).success)
    return (
      <section className="empty-page">
        <h1>Geçersiz oda kodu</h1>
        <p>Oda kodları tam 6 rakamdan oluşur.</p>
        <Link to="/join" className="button button-primary">
          Oda kodunu gir
        </Link>
      </section>
    )
  return <RoomSessionPage key={code} code={code!} />
}

function RoomSessionPage({ code }: { code: string }) {
  // Re-read after an in-place join navigation, which may preserve this component.
  const session = loadSession(code)
  return session ? (
    <ConnectedRoom key={session.playerId} session={session} />
  ) : (
    <RoomEntry initialCode={code} />
  )
}

function ConnectedRoom({ session: initialSession }: { session: RoomSession }) {
  const [session] = useState(initialSession)
  const state = useRoom(session)
  const navigate = useNavigate()
  useEffect(() => {
    if (state.left) {
      clearSession(session.code)
      navigate('/', { replace: true })
    }
  }, [state.left, session.code, navigate])
  useEffect(() => {
    if (state.terminal) clearSession(session.code)
  }, [state.terminal, session.code])
  if (state.terminal)
    return (
      <section className="empty-page">
        <span className="eyebrow">Bağlantı sona erdi</span>
        <h1>Oda oturumun sona erdi.</h1>
        <p role="alert">{state.error}</p>
        <div className="room-actions">
          <button
            className="button button-primary"
            onClick={() => {
              clearSession(session.code)
              navigate('/join')
            }}
          >
            Bir odaya katıl
          </button>
          <Link className="button button-secondary" to="/">
            Sahnelere dön
          </Link>
        </div>
      </section>
    )
  if (!state.room)
    return (
      <section className="empty-page">
        <span className="eyebrow">Oda {session.code}</span>
        <h1>
          {state.status === 'disconnected' ? 'Bağlantı kurulamadı.' : 'Arkadaşlarına bağlanılıyor…'}
        </h1>
        <p role="status">{state.error ?? 'Özel lobin açılıyor.'}</p>
        <div className="room-actions">
          <button className="button button-primary" onClick={state.reconnect}>
            Yeniden bağlan
          </button>
          <Link className="button button-secondary" to="/join">
            Başka bir odaya katıl
          </Link>
        </div>
      </section>
    )
  if (state.room.status === 'finished') {
    const scene = resolveRoomScene(state.room)
    if (!scene)
      return (
        <section className="empty-page">
          <h1>Sahne bulunamadı.</h1>
        </section>
      )
    return <SharedResultScreen room={state.room} session={session} scene={scene} />
  }
  if (state.room.status === 'playing' || state.room.status === 'processing')
    return (
      <PlaybackScreen
        room={state.room}
        session={session}
        connectionStatus={state.status}
        connectionError={state.error}
        saved={isSessionSaved(session.code)}
        onLeave={() => state.send({ type: 'LEAVE_ROOM' })}
        onReconnect={state.reconnect}
        onFinalize={() => state.send({ type: 'FINALIZE_RECORDINGS' })}
      />
    )
  return (
    <Lobby
      room={state.room}
      playerId={session.playerId}
      connectionStatus={state.status}
      error={state.error}
      pending={state.pending}
      saved={isSessionSaved(session.code)}
      onReady={(ready) => state.send({ type: 'PLAYER_READY', ready })}
      onStart={() => state.send({ type: 'START_GAME' })}
      onLeave={() => state.send({ type: 'LEAVE_ROOM' })}
      onReconnect={state.reconnect}
    />
  )
}
