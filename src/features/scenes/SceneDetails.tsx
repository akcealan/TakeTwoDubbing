import { Link, useParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { NotFound } from '../../components/NotFound'
import { sceneGenreLabels, sceneDifficultyLabels } from '../../lib/sceneLabels'
import { formatTimestamp } from '../../lib/time'
import { useScene } from '../../hooks/useSceneCatalog'
import { SceneThumbnail } from './SceneThumbnail'

export function SceneDetails() {
  const { sceneId } = useParams()
  const { scene, loading } = useScene(sceneId)
  if (loading)
    return (
      <section className="empty-page">
        <h1>Özel sahne yükleniyor…</h1>
      </section>
    )
  if (!scene) return <NotFound scene />

  return (
    <div className={`details-page accent-${scene.accent}`}>
      <Link to="/" className="back-link">
        <Icon name="back" /> Sahne arşivine dön
      </Link>
      <section className="detail-grid" aria-labelledby="scene-title">
        <div className="detail-art">
          <SceneThumbnail
            scene={scene}
            alt={`${scene.title} sahne karesi`}
            width={960}
            height={600}
            fallback={
              <div className="scene-poster neutral-poster">
                <Icon name="film" />
                <small>Küçük resim hazırlanmadı</small>
              </div>
            }
          />
          <span className="poster-label">
            {scene.origin.kind === 'private'
              ? 'Özel sahne'
              : scene.mediaStatus === 'available'
                ? 'Oynatılabilir özgün demo'
                : 'Özgün demo'}
          </span>
          <div className="media-notice">
            <Icon name="film" />
            <span>
              {scene.mediaStatus === 'available' ? 'Video hazır' : 'Sahne taslağı'}
              <span>
                {scene.mediaStatus === 'available'
                  ? 'Oyun başlayınca canonical zaman çizelgesiyle oynatılır.'
                  : 'Oynatılabilir video henüz eklenmedi.'}
              </span>
            </span>
          </div>
        </div>
        <div className="detail-copy">
          <span className="eyebrow">
            {sceneGenreLabels[scene.genre]} / {sceneDifficultyLabels[scene.difficulty]}
          </span>
          <h1 id="scene-title">{scene.title}</h1>
          <p>{scene.description}</p>
          <div className="detail-meta">
            <span>
              <Icon name="clock" />
              {formatTimestamp(scene.durationMs)}
            </span>
            <span>
              <Icon name="people" />
              {scene.characters.length} karakter
            </span>
            <span>
              <Icon name="mic" />
              {scene.lines.length} replik
            </span>
          </div>
          <div className="room-preview">
            <h2>Bir sonraki oyun gecen burada başlıyor.</h2>
            <p>
              Özel bir lobi oluştur ve arkadaşlarını davet et. Aşağıda karakterleri tanıyıp
              repliklere göz atabilirsin.
            </p>
            <Link
              className="button button-primary w-full"
              to={`/scenes/${scene.id}/create`}
              aria-describedby="room-availability"
            >
              Oda oluştur <Icon name="arrow" />
            </Link>
            <span id="room-availability">Canlı lobi, oyun başlangıcı ve rol dağıtımı hazır.</span>
            {scene.origin.kind === 'private' && (
              <Link className="text-button" to={`/studio/${scene.id}`}>
                Sahneyi Stüdyoda düzenle
              </Link>
            )}
          </div>
        </div>
      </section>
      <section className="cast-section" aria-labelledby="cast-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Yeni rollerinle tanış</span>
            <h2 id="cast-title">Karakterler</h2>
          </div>
          <span className="library-count">Roller oyun başladığında dağıtılacak</span>
        </div>
        <div className="cast-grid">
          {scene.characters.map((character, index) => (
            <article key={character.id} className="cast-card">
              <span className={`avatar avatar-${index}`}>
                {character.name
                  .split(' ')
                  .map((part) => part[0])
                  .join('')
                  .slice(0, 2)}
              </span>
              <div>
                <h3>{character.name}</h3>
                <p>
                  {scene.lines.filter((line) => line.characterId === character.id).length} replik
                </p>
              </div>
              <Icon name="mic" />
            </article>
          ))}
        </div>
      </section>
      <section className="script-section" aria-labelledby="script-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Senaryoya göz at</span>
            <h2 id="script-title">Replikler</h2>
          </div>
          <span className="library-count">Süreler dakika:saniye olarak gösterilir</span>
        </div>
        <ol className="script-list">
          {scene.lines.map((line) => (
            <li key={line.id}>
              <span className="line-time">
                {formatTimestamp(line.startMs)} <span>— {formatTimestamp(line.endMs)}</span>
              </span>
              <div>
                <span className="line-character">
                  {scene.characters.find((character) => character.id === line.characterId)?.name}
                </span>
                <p>“{line.text}”</p>
              </div>
              <span className="script-dot" />
            </li>
          ))}
        </ol>
        <p className="content-credit">{scene.contentCredit}</p>
      </section>
    </div>
  )
}
