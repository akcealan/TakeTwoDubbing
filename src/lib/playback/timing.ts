import type { DialogueLine } from '../../../shared/types'

export type DialogueTimingState = 'completed' | 'active' | 'upcoming'

export interface PlaybackTimeline {
  currentMs: number
  progress: number
  activeLines: DialogueLine[]
  completedLines: DialogueLine[]
  upcomingLines: DialogueLine[]
  ownedLines: DialogueLine[]
  activeOwnedLines: DialogueLine[]
  nextOwnedLine: DialogueLine | null
}

export function normalizePlaybackTime(milliseconds: number, durationMs: number): number {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
    throw new RangeError('Duration must be a positive safe integer in milliseconds.')
  if (!Number.isFinite(milliseconds)) return 0
  return Math.min(durationMs, Math.max(0, Math.round(milliseconds)))
}

export function dialogueTimingState(line: DialogueLine, currentMs: number): DialogueTimingState {
  if (line.endMs <= currentMs) return 'completed'
  if (line.startMs <= currentMs) return 'active'
  return 'upcoming'
}

export function getPlaybackTimeline(
  lines: readonly DialogueLine[],
  durationMs: number,
  milliseconds: number,
  ownedCharacterIds: ReadonlySet<string>,
): PlaybackTimeline {
  const currentMs = normalizePlaybackTime(milliseconds, durationMs)
  const ordered = [...lines].sort(
    (left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
  )
  const activeLines = ordered.filter((line) => line.startMs <= currentMs && currentMs < line.endMs)
  const completedLines = ordered.filter((line) => line.endMs <= currentMs)
  const upcomingLines = ordered.filter((line) => line.startMs > currentMs)
  const ownedLines = ordered.filter((line) => ownedCharacterIds.has(line.characterId))
  return {
    currentMs,
    progress: currentMs / durationMs,
    activeLines,
    completedLines,
    upcomingLines,
    ownedLines,
    activeOwnedLines: activeLines.filter((line) => ownedCharacterIds.has(line.characterId)),
    nextOwnedLine: upcomingLines.find((line) => ownedCharacterIds.has(line.characterId)) ?? null,
  }
}
