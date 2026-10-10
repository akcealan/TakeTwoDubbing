import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { sceneGenreLabels } from '../../lib/sceneLabels'
import { SceneCard } from './SceneCard'
import { SceneSpotlight } from './SceneSpotlight'
import { useSceneCatalog } from '../../hooks/useSceneCatalog'

const filters = ['All scenes', 'Sci-fi', 'Comedy'] as const
type Filter = (typeof filters)[number]

export function SceneLibrary() {
  const { scenes, error, loading } = useSceneCatalog()
  const featuredScene = scenes[0]
  const [filter, setFilter] = useState<Filter>('All scenes')
  const [search, setSearch] = useState('')
  const visibleScenes = scenes.filter(
    (scene) =>
      (filter === 'All scenes' || scene.genre === filter) &&
      `${scene.title} ${scene.description} ${sceneGenreLabels[scene.genre]}`
        .toLocaleLowerCase('tr-TR')
        .includes(search.trim().toLocaleLowerCase('tr-TR')),
  )

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="live-dot" /> Oyun gecesine yeni bir ses
          </span>
          <h1>
            Harika sahneler.
            <br />
            Bolca <span className="highlight">kahkaha.</span>
          </h1>
          <p>
            Sahnelere kendi sesini kat. İçindeki oyuncuyu ortaya çıkar, arkadaşlarınla unutulmaz bir
            dublaj gecesi yaşa.
          </p>
          <a href="#scene-library" className="button button-primary">
            Sahneni seç <Icon name="arrow" />
          </a>
          <Link to="/studio" className="button button-secondary">
            Klibini yükle
          </Link>
          <div className="hero-footnote">
            <span className="mini-wave">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>{' '}
            Arkadaşların. Repliklerin. Senin yorumun.
          </div>
        </div>
        {featuredScene && <SceneSpotlight scene={featuredScene} />}
      </section>
      <section id="scene-library" className="library-section" aria-labelledby="library-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Oyuncular aranıyor</span>
            <h2 id="library-title">Bir sahne seç. Kendi yorumunu kat.</h2>
          </div>
          <span className="library-count">{scenes.length} sahne</span>
        </div>
        <div className="library-toolbar">
          <div className="filter-list" role="group" aria-label="Sahneleri türe göre filtrele">
            {filters.map((item) => (
              <button
                key={item}
                type="button"
                className={`filter-button ${filter === item ? 'selected' : ''}`}
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
              >
                {item === 'All scenes' ? 'Tüm sahneler' : sceneGenreLabels[item]}
              </button>
            ))}
          </div>
          <label className="search-field">
            <Icon name="search" />
            <span className="sr-only">Sahne ara</span>
            <input
              type="search"
              placeholder="Sıradaki sahneni bul..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <span role="status" className="sr-only">
          {visibleScenes.length} sahne bulundu
        </span>
        {error && (
          <p className="room-error" role="status">
            Özel sahneler şu anda alınamadı. Biraz sonra yeniden deneyebilirsin.
          </p>
        )}
        {loading ? (
          <div className="empty-results" role="status">
            <Icon name="film" />
            <h3>Sahnelerin yükleniyor…</h3>
          </div>
        ) : visibleScenes.length ? (
          <div className="scene-grid">
            {visibleScenes.map((scene) => (
              <SceneCard key={scene.id} scene={scene} />
            ))}
          </div>
        ) : (
          <div className="empty-results">
            <Icon name={scenes.length ? 'search' : 'film'} />
            <h3>{scenes.length ? 'Sahne bulunamadı' : 'Henüz hazırlanmış sahnen yok.'}</h3>
            <p>
              {scenes.length
                ? 'Başka bir sahne adı veya tür dene.'
                : "Sahne Stüdyosu'ndan yeni bir sahne hazırlayabilirsin."}
            </p>
            {scenes.length ? (
              <button
                className="button button-secondary"
                onClick={() => {
                  setFilter('All scenes')
                  setSearch('')
                }}
              >
                Filtreleri temizle
              </button>
            ) : (
              <Link className="button button-primary" to="/studio">
                Sahne Stüdyosu'nu aç
              </Link>
            )}
          </div>
        )}
      </section>
      <section id="how-it-works" className="how-section" aria-labelledby="how-title">
        <div className="how-intro">
          <span className="eyebrow">Oynaması kolay</span>
          <h2 id="how-title">
            Az hazırlık. <br />
            Bol eğlence.
          </h2>
          <span className="coming-label">Oyunun tamamı yakında</span>
        </div>
        <div className="how-steps">
          {[
            {
              number: '01',
              icon: 'film',
              title: 'Sahneyi seç',
              text: 'Bir sahne seç, özel odanı oluştur ve arkadaşlarını davet et.',
            },
            {
              number: '02',
              icon: 'mic',
              title: 'Rolüne ses ver',
              text: 'Karakterini tanı, repliklerini kaydet ve rolünün hakkını ver.',
            },
            {
              number: '03',
              icon: 'play',
              title: 'Gösterinin tadını çıkar',
              text: 'Herkesin performansının birleştiği videoyu birlikte izleyin.',
            },
          ].map((step) => (
            <div className="how-step" key={step.number}>
              <div className="step-top">
                <Icon name={step.icon as 'film' | 'mic' | 'play'} />
                <span>{step.number}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
