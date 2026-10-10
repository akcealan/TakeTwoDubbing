import { Link } from 'react-router-dom'
import type { Scene } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { sceneGenreLabels, sceneDifficultyLabels } from '../../lib/sceneLabels'
import { formatTimestamp } from '../../lib/time'
import { SceneThumbnail } from './SceneThumbnail'

export function SceneCard({ scene }: { scene: Scene }) {
  return (
    <article className={`scene-card accent-${scene.accent}`}>
      <Link
        to={`/scenes/${scene.id}`}
        className="scene-poster-link"
        aria-label={`İncele: ${scene.title}`}
      >
        <SceneThumbnail
          scene={scene}
          alt={`${scene.title} afişi`}
          className="scene-poster"
          width={960}
          height={600}
          fallback={
            <span
              className="scene-poster neutral-poster"
              role="img"
              aria-label="Bu sahne için küçük resim hazırlanmadı"
            >
              <Icon name="film" />
              <small>Küçük resim yok</small>
            </span>
          }
        />
        <span className="poster-label">
          {scene.origin.kind === 'private'
            ? 'Özel sahne'
            : scene.mediaStatus === 'available'
              ? 'Oynatılabilir demo'
              : 'Özgün demo'}
        </span>
        <span className="poster-time">{formatTimestamp(scene.durationMs)}</span>
        <span className="poster-play">
          <Icon name="arrow" />
        </span>
      </Link>
      <div className="card-body">
        <div className="flex items-center gap-2">
          <span className="genre-label">{sceneGenreLabels[scene.genre]}</span>
          <span className="text-muted">/</span>
          <span className="text-muted text-xs">{sceneDifficultyLabels[scene.difficulty]}</span>
        </div>
        <h3>
          <Link to={`/scenes/${scene.id}`}>{scene.title}</Link>
        </h3>
        <p>{scene.description}</p>
        <div className="card-bottom">
          <span>
            <Icon name="people" />
            {scene.characters.length} karakter<span className="meta-divider">·</span>
            {scene.lines.length} replik
          </span>
          <Link
            to={`/scenes/${scene.id}`}
            className="card-action"
            aria-label={`Sahneyi incele: ${scene.title}`}
          >
            Sahneyi incele <Icon name="arrow" />
          </Link>
          {scene.origin.kind === 'private' && (
            <Link className="text-button" to={`/studio/${scene.id}`}>
              Düzenle
            </Link>
          )}
        </div>
      </div>
    </article>
  )
}
