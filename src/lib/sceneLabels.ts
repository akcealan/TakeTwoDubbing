import type { Scene } from '../../shared/types'

export const sceneGenreLabels: Record<Scene['genre'], string> = {
  'Sci-fi': 'Bilim kurgu',
  Comedy: 'Komedi',
  Custom: 'Özel sahne',
}

export const sceneDifficultyLabels: Record<Scene['difficulty'], string> = {
  Easy: 'Kolay',
  Medium: 'Orta',
  Prepared: 'Hazırlandı',
}
