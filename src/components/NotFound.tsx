import { Link } from 'react-router-dom'
import { Icon } from './Icon'

export function NotFound({ scene = false }: { scene?: boolean }) {
  return (
    <section className="empty-page">
      <span className="eyebrow">Senaryo dışına çıktık</span>
      <h1>{scene ? 'Sahne bulunamadı' : 'Bu sayfa sahneye çıkamadı.'}</h1>
      <p>
        {scene
          ? 'Bu sahne arşivde yok. Başka bir sahne seçebilirsin.'
          : 'Bağlantı eksik olabilir ya da bu sayfa artık mevcut değil.'}
      </p>
      <Link className="button button-primary" to="/">
        <Icon name="back" /> Sahnelere dön
      </Link>
    </section>
  )
}
