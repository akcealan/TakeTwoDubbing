import { describe, expect, it } from 'vitest'
import type { DialogueLine } from '../../../shared/types'
import {
  getGuidedAttemptPlan,
  getGuidedLineTiming,
  getOrderedOwnedLines,
  getPreRollStartMs,
} from './guidedTiming'
import { POST_RECORD_GRACE_MS, PRE_RECORD_GRACE_MS } from '../../../shared/recordingTiming'

const line: DialogueLine = {
  id: 'line',
  characterId: 'one',
  startMs: 5_000,
  endMs: 8_500,
  text: 'Replik',
}

describe('guided dubbing timing', () => {
  it('clamps pre-roll at scene start', () => {
    expect(getPreRollStartMs({ ...line, startMs: 1_000 })).toBe(0)
    expect(getPreRollStartMs(line)).toBe(1_000)
  })

  it('derives the countdown, speaking progress and canonical end from media time', () => {
    expect(getGuidedLineTiming(line, 2_001).countdown).toBe(3)
    expect(getGuidedLineTiming(line, 3_001).countdown).toBe(2)
    expect(getGuidedLineTiming(line, 4_001).countdown).toBe(1)
    expect(getGuidedLineTiming(line, 5_000)).toMatchObject({ speaking: true, speakingProgress: 0 })
    expect(getGuidedLineTiming(line, 6_750)).toMatchObject({
      speaking: true,
      speakingProgress: 0.5,
      remainingSpeakingMs: 1_750,
    })
    expect(getGuidedLineTiming(line, 8_500)).toMatchObject({
      afterCanonical: true,
      complete: false,
      speakingProgress: 1,
      remainingSpeakingMs: 0,
    })
    expect(getGuidedLineTiming(line, 9_000)).toMatchObject({ complete: true })
  })

  it('keeps canonical timing unchanged while deriving a bounded grace window', () => {
    const canonical = { ...line }
    expect(getGuidedAttemptPlan(line, 10_000)).toMatchObject({
      captureStartMs: line.startMs - PRE_RECORD_GRACE_MS,
      captureEndMs: line.endMs + POST_RECORD_GRACE_MS,
    })
    expect(getGuidedAttemptPlan({ ...line, startMs: 0 }, 8_700)).toMatchObject({
      captureStartMs: 0,
      captureEndMs: 8_700,
    })
    expect(line).toEqual(canonical)
  })

  it('supplies the full countdown before a line at scene start', () => {
    const firstLine = { ...line, startMs: 0, endMs: 850 }
    const plan = getGuidedAttemptPlan(firstLine, 15_000)
    expect(plan).toMatchObject({ preRollStartMs: 0, preparationHoldMs: 3_000 })
    expect(
      getGuidedLineTiming(firstLine, 0, {
        sceneDurationMs: 15_000,
        preparationElapsedMs: 0,
      }),
    ).toMatchObject({ countdown: 3, speaking: false, captureActive: false })
    expect(
      getGuidedLineTiming(firstLine, 0, {
        sceneDurationMs: 15_000,
        preparationElapsedMs: 1_001,
      }).countdown,
    ).toBe(2)
    expect(
      getGuidedLineTiming(firstLine, 0, {
        sceneDurationMs: 15_000,
        preparationElapsedMs: 2_001,
      }).countdown,
    ).toBe(1)
    expect(
      getGuidedLineTiming(firstLine, 0, {
        sceneDurationMs: 15_000,
        preparationElapsedMs: 3_000,
      }),
    ).toMatchObject({ countdown: null, speaking: true, captureActive: true })
  })

  it('holds only the missing countdown lead-in before playing available source pre-roll', () => {
    const earlyLine = { ...line, startMs: 1_200, endMs: 2_050 }
    const plan = getGuidedAttemptPlan(earlyLine, 15_000)
    expect(plan).toMatchObject({ preRollStartMs: 0, preparationHoldMs: 1_800 })
    expect(
      getGuidedLineTiming(earlyLine, 0, {
        sceneDurationMs: 15_000,
        preparationElapsedMs: 0,
      }).countdown,
    ).toBe(3)
    expect(
      getGuidedLineTiming(earlyLine, 700, {
        sceneDurationMs: 15_000,
        preparationElapsedMs: 1_800,
      }),
    ).toMatchObject({ countdown: 1, captureActive: true, speaking: false })
    expect(
      getGuidedLineTiming(earlyLine, 1_200, {
        sceneDurationMs: 15_000,
        preparationElapsedMs: 1_800,
      }),
    ).toMatchObject({ countdown: null, speaking: true })
  })

  it('keeps the normal video pre-roll when the scene has enough lead-in', () => {
    expect(getGuidedAttemptPlan(line, 10_000)).toMatchObject({
      preRollStartMs: 1_000,
      preparationHoldMs: 0,
    })
  })

  it('orders all owned characters canonically and ignores overlapping unowned dialogue', () => {
    const lines: DialogueLine[] = [
      { ...line, id: 'later', characterId: 'two', startMs: 9_000, endMs: 11_000 },
      { ...line, id: 'overlap', characterId: 'other', startMs: 5_500, endMs: 7_000 },
      { ...line, id: 'first', characterId: 'one', startMs: 1_000, endMs: 4_000 },
    ]
    expect(getOrderedOwnedLines(lines, new Set(['one', 'two'])).map((entry) => entry.id)).toEqual([
      'first',
      'later',
    ])
    expect(getGuidedLineTiming(line, 7_000).remainingSpeakingMs).toBe(1_500)
  })
})
