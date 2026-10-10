import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { nicknameSchema, roomCodeSchema } from '../../../shared/schemas/room'
import {
  createJoinRoomRequest,
  createRoom,
  joinRoom,
  type JoinRoomRequest,
} from '../../lib/api/rooms'
import { saveSession } from '../../lib/rooms/session'
import { Icon } from '../../components/Icon'
import { NotFound } from '../../components/NotFound'
import { useScene } from '../../hooks/useSceneCatalog'
import { SceneThumbnail } from '../scenes/SceneThumbnail'

export function CreateRoomPage() {
  const { sceneId } = useParams()
  const { scene, loading } = useScene(sceneId)
  if (loading)
    return (
      <section className="empty-page">
        <h1>Sahne yükleniyor…</h1>
      </section>
    )
  if (!scene) return <NotFound scene />
  return <RoomEntry sceneId={scene.id} />
}

export function RoomEntry({
  sceneId,
  initialCode = '',
}: {
  sceneId?: string
  initialCode?: string
}) {
  const navigate = useNavigate()
  const { scene } = useScene(sceneId)
  const [nickname, setNickname] = useState('')
  const [code, setCode] = useState(initialCode)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const request = useRef<AbortController | null>(null)
  const joinRequest = useRef<JoinRoomRequest | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  return (
    <section className="room-entry">
      <Link className="back-link" to={scene ? `/scenes/${scene.id}` : '/'}>
        <Icon name="back" /> {scene ? 'Sahneye dön' : 'Sahnelere dön'}
      </Link>
      <span className="eyebrow">Sohbet grubunu sahneye taşı</span>
      <h1>{scene ? 'Arkadaşlarına yer aç.' : 'Arkadaşların sana yer ayırdı.'}</h1>
      <p>
        {scene
          ? `${scene.title} için özel bir lobi oluştur.`
          : 'Oda kodunu gir, bir takma ad seç. Üyelik gerekmiyor.'}
      </p>
      {scene && (
        <div className="entry-scene">
          <SceneThumbnail
            scene={scene}
            alt=""
            width={120}
            height={75}
            fallback={
              <span className="neutral-poster">
                <Icon name="film" />
              </span>
            }
          />
          <div>
            <strong>{scene.title}</strong>
            <span>
              {scene.characters.length} karakter ·{' '}
              {scene.origin.kind === 'private' ? 'Özel sahne' : 'Özgün demo'}
            </span>
          </div>
        </div>
      )}
      <form
        className="entry-form"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault()
          if (pending) return
          const name = nicknameSchema.safeParse(nickname)
          if (!name.success) {
            setError(name.error.issues[0]?.message ?? 'Geçerli bir takma ad gir.')
            return
          }
          if (!scene && !roomCodeSchema.safeParse(code).success) {
            setError('Oda kodu tam 6 rakamdan oluşmalı.')
            return
          }
          setPending(true)
          setError(null)
          request.current = new AbortController()
          try {
            const session = scene
              ? await createRoom(scene.id, name.data, request.current.signal)
              : await joinRoom(
                  code,
                  (joinRequest.current ??= createJoinRoomRequest(name.data)),
                  request.current.signal,
                )
            if (request.current.signal.aborted) return
            saveSession(session)
            navigate(`/room/${session.code}`, { replace: Boolean(initialCode) })
          } catch (failure) {
            if (!request.current.signal.aborted)
              setError(
                failure instanceof Error
                  ? failure.message
                  : 'Odaya girilemedi. Lütfen tekrar dene.',
              )
          } finally {
            setPending(false)
          }
        }}
      >
        {!scene && (
          <label>
            Oda kodu
            <input
              name="code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(event) => {
                setCode(event.target.value)
                joinRequest.current = null
              }}
              aria-describedby="entry-error"
            />
          </label>
        )}
        <label>
          Takma adın
          <input
            name="nickname"
            autoComplete="nickname"
            minLength={2}
            maxLength={20}
            placeholder="Sana ne diyelim?"
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value)
              joinRequest.current = null
            }}
            aria-describedby="nickname-help entry-error"
          />
        </label>
        <span id="nickname-help" className="field-help">
          2–20 karakter. Harf, rakam, boşluk, _ veya - kullanabilirsin.
        </span>
        {error && (
          <p id="entry-error" role="alert" className="room-error">
            {error}
          </p>
        )}
        <button className="button button-primary w-full" disabled={pending} type="submit">
          {pending ? 'Bağlanıyor…' : scene ? 'Oda oluştur' : 'Odaya katıl'}
          <Icon name="arrow" />
        </button>
      </form>
      <p className="field-help">
        Canlı lobi hazır. Oyunu başlatma ve ses kaydı özellikleri yakında.
      </p>
    </section>
  )
}
