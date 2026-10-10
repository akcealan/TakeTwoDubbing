import { sceneCatalogSchema } from '../schemas/scene'

// Original development scripts. Video paths are reserved metadata, not playable assets.
export const scenes = sceneCatalogSchema.parse([
  {
    id: 'a-small-step',
    title: 'Küçük Bir Adım',
    description:
      'Çok ciddi bir uzay görevi. Hiç hazır olmayan iki astronot. Ve sonunda sabrı taşan bir gemi bilgisayarı.',
    durationMs: 30000,
    videoUrl: '/scenes/a-small-step/video.webm',
    thumbnailUrl: '/scenes/a-small-step/poster.svg',
    genre: 'Sci-fi',
    difficulty: 'Easy',
    accent: 'violet',
    mediaStatus: 'available',
    sourceAudioStatus: 'silent',
    contentCredit:
      'Take Two için hazırlanmış özgün demo senaryosu, vektör çizimi ve sessiz geliştirme animasyonu.',
    characters: [
      { id: 'nova', name: 'Kaptan Nova' },
      { id: 'pip', name: 'Pip' },
      { id: 'echo', name: 'ECHO' },
    ],
    lines: [
      {
        id: 'step-1',
        characterId: 'nova',
        startMs: 1000,
        endMs: 4500,
        text: 'Ekip, tarihî bir an yaşıyoruz. Bari işi biliyormuş gibi görünün.',
      },
      {
        id: 'step-2',
        characterId: 'pip',
        startMs: 5000,
        endMs: 8500,
        text: 'Bunun için bir düğme var mı?',
      },
      {
        id: 'step-3',
        characterId: 'echo',
        startMs: 9500,
        endMs: 13500,
        text: 'Kontrol ettim. Doğru düğme dışında hepsine bastınız.',
      },
      {
        id: 'step-4',
        characterId: 'nova',
        startMs: 15000,
        endMs: 18500,
        text: 'Harika. Seçenekleri tek tek eledik.',
      },
      {
        id: 'step-5',
        characterId: 'pip',
        startMs: 20000,
        endMs: 23500,
        text: 'Ay’da neden parkmetre var?',
      },
      {
        id: 'step-6',
        characterId: 'echo',
        startMs: 25000,
        endMs: 29000,
        text: 'Çünkü biri kısa süreli yörüngeyi seçmiş.',
      },
    ],
  },
  {
    id: 'the-last-table',
    title: 'Son Masa',
    description:
      'Mum ışığında bir akşam yemeği, şefin özel tabağıyla tuhaf bir hâl alır. Oysa kimse gizem sipariş etmemiştir.',
    durationMs: 24000,
    videoUrl: '/scenes/the-last-table/video.mp4',
    thumbnailUrl: '/scenes/the-last-table/poster.svg',
    genre: 'Comedy',
    difficulty: 'Easy',
    accent: 'amber',
    mediaStatus: 'placeholder',
    sourceAudioStatus: 'unknown',
    contentCredit:
      'Take Two için hazırlanmış özgün demo senaryosu ve vektör çizimi. Video henüz eklenmedi.',
    characters: [
      { id: 'robin', name: 'Robin' },
      { id: 'jules', name: 'Jules' },
      { id: 'chef', name: 'Şef Sol' },
    ],
    lines: [
      {
        id: 'table-1',
        characterId: 'chef',
        startMs: 1000,
        endMs: 4500,
        text: 'Bu akşam şefin özel tabağı bir sürpriz.',
      },
      {
        id: 'table-2',
        characterId: 'robin',
        startMs: 5000,
        endMs: 8000,
        text: 'Güzel bir sürpriz mi, sigortalık bir sürpriz mi?',
      },
      {
        id: 'table-3',
        characterId: 'jules',
        startMs: 9000,
        endMs: 12000,
        text: 'Sanırım tabak şarkı mırıldanıyor.',
      },
      {
        id: 'table-4',
        characterId: 'chef',
        startMs: 13000,
        endMs: 16000,
        text: 'Demek ki tam kıvamında.',
      },
      {
        id: 'table-5',
        characterId: 'robin',
        startMs: 17500,
        endMs: 20000,
        text: 'Onun yerine tatlı menüsünü dinleyebilir miyiz?',
      },
      {
        id: 'table-6',
        characterId: 'jules',
        startMs: 20500,
        endMs: 23500,
        text: 'Ama cheesecake istek parça kabul ediyorsa.',
      },
    ],
  },
])

export function getSceneById(id: string | undefined) {
  return scenes.find((scene) => scene.id === id)
}

export function resolveRoomScene(room: {
  sceneId: string
  sceneSnapshot?: (typeof scenes)[number]
}) {
  return room.sceneSnapshot ?? getSceneById(room.sceneId)
}
