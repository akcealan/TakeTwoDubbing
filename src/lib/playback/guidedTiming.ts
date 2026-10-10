import type { DialogueLine } from '../../../shared/types'
import { getRecordingCaptureWindow } from '../../../shared/recordingTiming'

export const GUIDED_PRE_ROLL_MS = 4_000
export const SPEAKING_COUNTDOWN_MS = 3_000

export interface GuidedAttemptPlan {
  preRollStartMs: number
  preparationHoldMs: number
  captureStartMs: number
  captureEndMs: number
}

export interface GuidedLineTiming extends GuidedAttemptPlan {
  preRollDurationMs: number
  speakingDurationMs: number
  totalDurationMs: number
  playheadProgress: number
  speakingProgress: number
  remainingSpeakingMs: number
  remainingCaptureMs: number
  countdown: 3 | 2 | 1 | null
  captureActive: boolean
  speaking: boolean
  afterCanonical: boolean
  complete: boolean
}

export interface GuidedTimingOptions {
  sceneDurationMs?: number
  preparationElapsedMs?: number
  preRollMs?: number
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function getPreRollStartMs(line: DialogueLine, preRollMs = GUIDED_PRE_ROLL_MS) {
  return Math.max(0, line.startMs - Math.max(0, preRollMs))
}

export function getGuidedAttemptPlan(
  line: DialogueLine,
  sceneDurationMs: number,
  preRollMs = GUIDED_PRE_ROLL_MS,
): GuidedAttemptPlan {
  return {
    preRollStartMs: getPreRollStartMs(line, preRollMs),
    preparationHoldMs: Math.max(0, SPEAKING_COUNTDOWN_MS - line.startMs),
    ...getRecordingCaptureWindow(line, sceneDurationMs),
  }
}

export function getGuidedLineTiming(
  line: DialogueLine,
  mediaTimeMs: number,
  options: GuidedTimingOptions = {},
): GuidedLineTiming {
  const sceneDurationMs = options.sceneDurationMs ?? line.endMs + 500
  const plan = getGuidedAttemptPlan(line, sceneDurationMs, options.preRollMs)
  const preparationElapsedMs = clamp(
    options.preparationElapsedMs ?? plan.preparationHoldMs,
    0,
    plan.preparationHoldMs,
  )
  const preparationRemainingMs = plan.preparationHoldMs - preparationElapsedMs
  const speakingDurationMs = line.endMs - line.startMs
  const currentMs = clamp(
    Number.isFinite(mediaTimeMs) ? mediaTimeMs : plan.preRollStartMs,
    plan.preRollStartMs,
    plan.captureEndMs,
  )
  const mediaElapsedMs = preparationRemainingMs > 0 ? 0 : currentMs - plan.preRollStartMs
  const totalDurationMs = plan.preparationHoldMs + plan.captureEndMs - plan.preRollStartMs
  const untilStartMs = preparationRemainingMs + Math.max(0, line.startMs - currentMs)
  const countdown =
    untilStartMs > 0 && untilStartMs <= SPEAKING_COUNTDOWN_MS
      ? (Math.ceil(untilStartMs / 1_000) as 3 | 2 | 1)
      : null

  return {
    ...plan,
    preRollDurationMs: line.startMs - plan.preRollStartMs,
    speakingDurationMs,
    totalDurationMs,
    playheadProgress:
      totalDurationMs === 0 ? 1 : (preparationElapsedMs + mediaElapsedMs) / totalDurationMs,
    speakingProgress: clamp((currentMs - line.startMs) / speakingDurationMs, 0, 1),
    remainingSpeakingMs: clamp(
      line.endMs - Math.max(currentMs, line.startMs),
      0,
      speakingDurationMs,
    ),
    remainingCaptureMs: clamp(
      plan.captureEndMs - Math.max(currentMs, plan.captureStartMs),
      0,
      plan.captureEndMs - plan.captureStartMs,
    ),
    countdown,
    captureActive:
      preparationRemainingMs === 0 &&
      plan.captureStartMs <= mediaTimeMs &&
      mediaTimeMs < plan.captureEndMs,
    speaking:
      preparationRemainingMs === 0 && line.startMs <= mediaTimeMs && mediaTimeMs < line.endMs,
    afterCanonical:
      preparationRemainingMs === 0 && line.endMs <= mediaTimeMs && mediaTimeMs < plan.captureEndMs,
    complete: preparationRemainingMs === 0 && mediaTimeMs >= plan.captureEndMs,
  }
}

export function getPreparationElapsedMs(
  startedAtMs: number,
  nowMs: number,
  preparationHoldMs: number,
) {
  return clamp(nowMs - startedAtMs, 0, preparationHoldMs)
}

export function getOrderedOwnedLines(
  lines: readonly DialogueLine[],
  ownedCharacterIds: ReadonlySet<string>,
) {
  return lines
    .filter((line) => ownedCharacterIds.has(line.characterId))
    .slice()
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
}
