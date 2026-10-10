import { sceneSchema } from '../../../shared/schemas/scene'
import type {
  AiEditableDraft,
  Character,
  DialogueLine,
  Scene,
  UploadedMedia,
} from '../../../shared/types'

export interface EditableScene {
  title: string
  description: string
  characters: Character[]
  lines: DialogueLine[]
}

export function canonicalLineOrder(lines: DialogueLine[]) {
  return [...lines].sort(
    (left, right) =>
      left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id),
  )
}

export function buildPrivateScene(
  media: UploadedMedia,
  editable: EditableScene,
  previousVersion = 0,
) {
  return sceneSchema.safeParse({
    id: media.sceneId,
    title: editable.title,
    description: editable.description,
    durationMs: media.durationMs,
    videoUrl: `/api/private-scenes/${media.sceneId}/source`,
    genre: 'Custom',
    difficulty: 'Prepared',
    accent: 'violet',
    mediaStatus: 'available',
    sourceAudioStatus: 'unknown',
    contentCredit: 'Kullanıcının özel kullanım için yüklediği içerik.',
    origin: { kind: 'private', version: previousVersion + 1, sourceFileName: media.filename },
    characters: editable.characters,
    lines: canonicalLineOrder(editable.lines),
  })
}

export function sceneValidationMessages(media: UploadedMedia, editable: EditableScene) {
  const parsed = buildPrivateScene(media, editable)
  if (parsed.success) return []
  return [...new Set(parsed.error.issues.map((issue) => turkishIssue(issue.path, issue.message)))]
}

function turkishIssue(path: PropertyKey[], fallback: string) {
  const key = path.join('.')
  if (key === 'title') return 'Sahne başlığı boş bırakılamaz.'
  if (key === 'characters') return 'En az bir karakter ekle.'
  if (key === 'lines') return 'En az bir geçerli replik ekle.'
  if (key.endsWith('characterId')) return 'Her replik var olan bir karaktere bağlı olmalı.'
  if (key.endsWith('text')) return 'Replik metni boş bırakılamaz.'
  if (key.endsWith('endMs'))
    return fallback.includes('duration')
      ? 'Replik video süresini aşamaz.'
      : 'Replik bitişi başlangıçtan sonra olmalı.'
  return 'Sahne bilgilerindeki eksik veya geçersiz alanları düzelt.'
}

export function editableFromScene(scene: Scene): EditableScene {
  return {
    title: scene.title,
    description: scene.description,
    characters: scene.characters,
    lines: scene.lines,
  }
}

export function editableFromAiDraft(current: EditableScene, draft: AiEditableDraft): EditableScene {
  return {
    ...current,
    characters: draft.characters,
    lines: canonicalLineOrder(draft.lines),
  }
}

export function removeCharacterSafely(editable: EditableScene, characterId: string) {
  if (editable.lines.some((line) => line.characterId === characterId))
    return {
      editable,
      error: 'Bu karaktere bağlı replikler var. Önce replikleri başka karaktere ata veya sil.',
    }
  return {
    editable: {
      ...editable,
      characters: editable.characters.filter((character) => character.id !== characterId),
    },
    error: null,
  }
}

export function deleteDialogueLine(editable: EditableScene, lineId: string) {
  return { ...editable, lines: editable.lines.filter((line) => line.id !== lineId) }
}

export function splitDialogueLine(
  editable: EditableScene,
  lineId: string,
  splitMs: number,
  textIndex?: number,
) {
  const ordered = canonicalLineOrder(editable.lines)
  const index = ordered.findIndex((line) => line.id === lineId)
  const line = ordered[index]
  if (!line || splitMs <= line.startMs || splitMs >= line.endMs)
    return { editable, newLineId: null, error: 'Oynatma konumu repliğin içinde olmalı.' }
  const newLineId = stableLineId(
    `${line.id}-bolum`,
    editable.lines.map((entry) => entry.id),
  )
  const [firstText, secondText] = splitLineText(line.text, splitMs, line, textIndex)
  ordered.splice(
    index,
    1,
    { ...line, text: firstText, endMs: splitMs },
    { ...line, id: newLineId, text: secondText, startMs: splitMs },
  )
  return { editable: { ...editable, lines: ordered }, newLineId, error: null }
}

export function mergeWithNextDialogueLine(editable: EditableScene, lineId: string) {
  const ordered = canonicalLineOrder(editable.lines)
  const index = ordered.findIndex((line) => line.id === lineId)
  const line = ordered[index]
  const next = ordered[index + 1]
  if (!line || !next)
    return { editable, removedLineId: null, error: 'Birleştirilecek sonraki replik yok.' }
  const merged: DialogueLine = {
    ...line,
    text: [line.text.trim(), next.text.trim()].filter(Boolean).join(' '),
    startMs: Math.min(line.startMs, next.startMs),
    endMs: Math.max(line.endMs, next.endMs),
  }
  ordered.splice(index, 2, merged)
  return {
    editable: { ...editable, lines: canonicalLineOrder(ordered) },
    removedLineId: next.id,
    error: null,
  }
}

export function nudgeDialogueBoundary(
  editable: EditableScene,
  lineId: string,
  boundary: 'startMs' | 'endMs',
  deltaMs: number,
  durationMs: number,
) {
  return {
    ...editable,
    lines: editable.lines.map((line) => {
      if (line.id !== lineId) return line
      if (boundary === 'startMs')
        return { ...line, startMs: clamp(line.startMs + deltaMs, 0, line.endMs - 1) }
      return { ...line, endMs: clamp(line.endMs + deltaMs, line.startMs + 1, durationMs) }
    }),
  }
}

function splitLineText(
  text: string,
  splitMs: number,
  line: DialogueLine,
  textIndex?: number,
): [string, string] {
  const trimmed = text.trim()
  if (!trimmed) return ['', '']
  let index = textIndex
  if (index === undefined || index <= 0 || index >= text.length) {
    const ratio = (splitMs - line.startMs) / (line.endMs - line.startMs)
    const target = Math.round(text.length * ratio)
    const spaces = [...text.matchAll(/\s+/g)].map((match) => match.index ?? 0)
    index = spaces.sort((left, right) => Math.abs(left - target) - Math.abs(right - target))[0]
  }
  if (index === undefined || index <= 0 || index >= text.length) return [trimmed, '']
  return [text.slice(0, index).trim(), text.slice(index).trim()]
}

function stableLineId(prefix: string, used: string[]) {
  if (!used.includes(prefix)) return prefix
  let index = 2
  while (used.includes(`${prefix}-${index}`)) index++
  return `${prefix}-${index}`
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}
