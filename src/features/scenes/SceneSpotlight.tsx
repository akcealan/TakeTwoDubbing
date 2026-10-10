import { Link } from 'react-router-dom'
import type { Scene } from '../../../shared/types'
import { Icon } from '../../components/Icon'
import { formatTimestamp } from '../../lib/time'
import { SceneThumbnail } from './SceneThumbnail'

export function SceneSpotlight({ scene }: { scene: Scene }) {
  return (
    <Link
      to={`/scenes/${scene.id}`}
      className="hero-feature"
      aria-label={`Öne çıkan sahneyi incele: ${scene.title}`}
    >
      <SceneThumbnail
        scene={scene}
        alt={`${scene.title} sahne karesi`}
        width={960}
        height={600}
        fallback={
          <span className="scene-poster neutral-poster">
            <Icon name="film" />
          </span>
        }
      />
      <div className="feature-top">
        <span className="feature-chip">
          <Icon name="sparkle" /> Sahne ışıkları altında
        </span>
        <span className="feature-number">ÖZEL SAHNE</span>
      </div>
      <div className="feature-bottom">
        <div>
          <span className="eyebrow">Sıradaki ses seninki olabilir.</span>
          <h2>{scene.title}</h2>
          <span>
            {formatTimestamp(scene.durationMs)} · {scene.characters.length} karakter · Hazırlanmış
            sahne
          </span>
        </div>
        <span className="feature-arrow">
          <Icon name="arrow" />
        </span>
      </div>
      <span className="orbit-caption">SAHNEYE HAZIR MISIN?</span>
    </Link>
  )
}
