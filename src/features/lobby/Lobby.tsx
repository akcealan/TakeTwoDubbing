import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Room } from '../../../shared/types'
import { MAX_PLAYERS } from '../../../shared/schemas/room'
import { resolveRoomScene } from '../../../shared/scenes/catalog'
import { Icon } from '../../components/Icon'
import type { ConnectionSnapshot } from '../../lib/websocket/RoomConnection'

interface LobbyProps {
  room: Room
  playerId: string
  connectionStatus: ConnectionSnapshot['status']
  error: string | null
  pending: boolean
  saved: boolean
  onReady: (ready: boolean) => void
  onStart: () => void
  onLeave: () => void
  onReconnect: () => void
}

export function Lobby({
  room,
  playerId,
  connectionStatus,
  error,
  pending,
  saved,
  onReady,
  onStart,
  onLeave,
  onReconnect,
}: LobbyProps) {
  const scene = resolveRoomScene(room)
  const me = room.players.find((player) => player.id === playerId)
  const host = room.players.find((player) => player.id === room.hostId)
  const online = connectionStatus === 'connected'
  const [copyStatus, setCopyStatus] = useState('')
  const connectedCount = room.players.filter((player) => player.connected).length
  const started = room.status === 'playing'
  const isHost = me?.id === room.hostId
  const canStart =
    room.status === 'lobby' &&
    connectedCount > 0 &&
    room.players.filter((player) => player.connected).every((player) => player.ready)
  const assignedCharacters =
    me?.characterIds.flatMap((characterId) => {
      const character = scene?.characters.find((entry) => entry.id === characterId)
      return character ? [character] : []
    }) ?? []
  return (
    <section className="lobby-page">
      <div className="lobby-heading">
        <div>
          <span className="eyebrow">
            {started ? 'Roller dağıtıldı, sahne senin.' : 'İyi arkadaşlar, bol kahkaha.'}
          </span>
          <h1>{started ? 'Oyun başladı.' : 'Sahne arkası.'}</h1>
          <p>
            {started
              ? 'Karakter atamaların sunucu tarafından yapıldı ve oda için sabitlendi.'
              : 'Ekibini topla, hazır olduğunu herkese bildir.'}
          </p>
        </div>
        <span role="status" className={`connection-badge ${online ? 'is-online' : ''}`}>
          <span />
          {online
            ? 'Bağlı'
            : connectionStatus === 'reconnecting'
              ? 'Yeniden bağlanıyor…'
              : 'Bağlantı kesildi'}
        </span>
      </div>
      {error && (
        <div role="alert" className="room-error">
          {error}
          {!online && (
            <button className="text-button" onClick={onReconnect}>
              Yeniden bağlan
            </button>
          )}
        </div>
      )}
      {!saved && (
        <p role="status" className="room-error">
          Tarayıcı oturumunu kaydedemiyor. Oturumunu korumak için bu sayfayı açık tut.
        </p>
      )}
      <div className="lobby-grid">
        <div className="lobby-main">
          <div className="invite-panel">
            <div>
              <span className="eyebrow">Özel oda kodun</span>
              <strong className="room-code" aria-label={`Oda kodu ${room.code}`}>
                {room.code}
              </strong>
              <p>Kodu veya davet bağlantısını arkadaşlarına gönder.</p>
            </div>
            <button
              className="button button-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    new URL(`/room/${room.code}`, window.location.origin).href,
                  )
                  setCopyStatus('Davet bağlantısı kopyalandı.')
                } catch {
                  setCopyStatus(
                    'Bağlantı kopyalanamadı. Aşağıdaki davet bağlantısını seçip kopyalayabilirsin.',
                  )
                }
              }}
            >
              Davet bağlantısını kopyala <Icon name="arrow" />
            </button>
            <input
              className="invite-link"
              aria-label="Davet bağlantısı"
              readOnly
              value={new URL(`/room/${room.code}`, window.location.origin).href}
              onFocus={(event) => event.target.select()}
            />
            <span role="status" className="field-help">
              {copyStatus}
            </span>
          </div>
          <div className="section-heading">
            <h2>
              Oyuncular{' '}
              <span className="text-muted">
                {connectedCount}/{MAX_PLAYERS}
              </span>
            </h2>
            <span className="field-help">{room.players.length} kişi katıldı</span>
          </div>
          <ul className="lobby-players">
            {room.players.map((player) => (
              <li key={player.id} data-testid={`player-${player.nickname}`}>
                <span className={`avatar ${player.connected ? '' : 'offline-avatar'}`}>
                  {player.nickname.slice(0, 2).toUpperCase()}
                </span>
                <div className="player-name">
                  <strong>
                    {player.nickname}
                    {player.id === playerId && <span className="you-label"> (sen)</span>}
                  </strong>
                  <span>{player.connected ? 'Lobide' : 'Bağlantısı kesildi · yeri ayrıldı'}</span>
                </div>
                {player.id === room.hostId && <span className="host-badge">Kurucu</span>}
                {started ? (
                  <span className={`ready-badge ${player.connected ? 'is-ready' : ''}`}>
                    {!player.connected
                      ? 'Çevrimdışı'
                      : player.characterIds.length
                        ? `${player.characterIds.length} karakter`
                        : 'Karakter atanmadı'}
                  </span>
                ) : (
                  <span
                    className={`ready-badge ${player.ready && player.connected ? 'is-ready' : ''}`}
                  >
                    {!player.connected ? 'Çevrimdışı' : player.ready ? 'Hazır' : 'Hazır değil'}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {!host?.connected && (
            <p role="status" className="room-error">
              Kurucunun bağlantısı kesildi. Biri bağlandığında oda yönetimi ona geçecek.
            </p>
          )}
          <p className="field-help">
            Kurucunun bağlantısı kesilirse oda yönetimi bağlı bir oyuncuya geçer. Bu sekmeyi
            yenilediğinde kimliğin korunur; bağlantın kesildiğinde hazır durumun sıfırlanır.
          </p>
        </div>
        <aside className="lobby-sidebar">
          {scene && (
            <Link to={`/scenes/${scene.id}`} className="lobby-scene">
              {scene.thumbnailUrl ? (
                <img
                  src={scene.thumbnailUrl}
                  alt={`${scene.title} özgün demo afişi`}
                  width="960"
                  height="600"
                />
              ) : (
                <span className="scene-poster neutral-poster">
                  <Icon name="film" />
                  <small>Küçük resim yok</small>
                </span>
              )}
              <span className="eyebrow">Bu akşamın sahnesi</span>
              <h2>{scene.title}</h2>
              <p>
                {scene.characters.length} karakter · {scene.lines.length} replik
              </p>
            </Link>
          )}
          <div className="lobby-controls">
            {started ? (
              <>
                <span className="eyebrow">Senin rolün</span>
                <h2>
                  {assignedCharacters.length
                    ? assignedCharacters.length === 1
                      ? assignedCharacters[0]!.name
                      : `${assignedCharacters.length} karakter`
                    : 'Bu turda karakterin yok'}
                </h2>
                {assignedCharacters.length ? (
                  <ul className="assignment-list" aria-label="Atanan karakterlerin">
                    {assignedCharacters.map((character) => (
                      <li key={character.id}>{character.name}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    Oyuncu sayısı karakter sayısından fazla olduğu için bu sahnede sana rol düşmedi.
                  </p>
                )}
                <p className="field-help">
                  Atamalar sabittir. Ses kaydı sonraki aşamada eklenecek; mikrofon izni istenmez.
                </p>
              </>
            ) : (
              <>
                <span className="eyebrow">Sahneye hazırlık</span>
                <h2>{me?.ready ? 'Hazırsın!' : 'Sahneye hazır mısın?'}</h2>
                <p>
                  {isHost
                    ? 'Bu odanın kurucususun. Bağlı herkes hazır olduğunda oyunu başlatabilirsin.'
                    : `Odanın kurucusu: ${host?.nickname ?? 'Henüz bağlı değil'}.`}
                </p>
                <button
                  className="button button-primary w-full"
                  disabled={!online || pending}
                  onClick={() => onReady(!me?.ready)}
                >
                  {pending ? 'Güncelleniyor…' : me?.ready ? 'Henüz hazır değilim' : 'Hazırım'}
                </button>
                {isHost && (
                  <button
                    className="button button-secondary w-full start-game-button"
                    disabled={!online || pending || !canStart}
                    onClick={onStart}
                  >
                    {pending ? 'İşleniyor…' : 'Oyunu Başlat'}
                  </button>
                )}
                <p className="field-help">
                  {canStart
                    ? 'Bağlı herkes hazır. Karakterler oyun başlayınca bir kez dağıtılır.'
                    : 'Oyunu başlatmak için bağlı oyuncuların tamamı hazır olmalı.'}
                </p>
              </>
            )}
            <button
              className="text-button leave-button"
              disabled={!online || pending}
              onClick={onLeave}
            >
              Odadan ayrıl
            </button>
          </div>
          <p className="field-help">
            Katılma, yeniden bağlanma, hazır durumu değişikliği veya oyun başlangıcı olmazsa oda 3
            saat sonra kapanır. Odadan ayrıldığında takma adın yeniden kullanılabilir.
          </p>
        </aside>
      </div>
    </section>
  )
}
