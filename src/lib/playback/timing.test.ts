import { describe, expect, it } from 'vitest'
import type { DialogueLine } from '../../../shared/types'
import { dialogueTimingState, getPlaybackTimeline, normalizePlaybackTime } from './timing'

const lines: DialogueLine[] = [
  { id: 'line-a', characterId: 'a', startMs: 1000, endMs: 4000, text: 'A' },
  { id: 'line-b', characterId: 'b', startMs: 2500, endMs: 5000, text: 'B' },
  { id: 'line-c', characterId: 'c', startMs: 6000, endMs: 8000, text: 'C' },
  { id: 'line-d', characterId: 'a', startMs: 9000, endMs: 11000, text: 'D' },
]

describe('canonical playback timing', () => {
  it('normalizes browser time to bounded integer milliseconds', () => {
    expect(normalizePlaybackTime(1234.6, 10_000)).toBe(1235)
    expect(normalizePlaybackTime(-50, 10_000)).toBe(0)
    expect(normalizePlaybackTime(12_000, 10_000)).toBe(10_000)
    expect(normalizePlaybackTime(Number.NaN, 10_000)).toBe(0)
    expect(() => normalizePlaybackTime(0, 0)).toThrow(RangeError)
  })

  it('classifies exact start and end boundaries consistently', () => {
    expect(dialogueTimingState(lines[0]!, 999)).toBe('upcoming')
    expect(dialogueTimingState(lines[0]!, 1000)).toBe('active')
    expect(dialogueTimingState(lines[0]!, 4000)).toBe('completed')
  })

  it('returns every overlapping active dialogue line', () => {
    const timeline = getPlaybackTimeline(lines, 12_000, 3000, new Set())
    expect(timeline.activeLines.map((line) => line.id)).toEqual(['line-a', 'line-b'])
    expect(timeline.completedLines).toEqual([])
    expect(timeline.upcomingLines.map((line) => line.id)).toEqual(['line-c', 'line-d'])
    expect(timeline.progress).toBe(0.25)
  })

  it('finds owned dialogue across multiple assigned characters', () => {
    const timeline = getPlaybackTimeline(lines, 12_000, 3000, new Set(['a', 'c']))
    expect(timeline.ownedLines.map((line) => line.id)).toEqual(['line-a', 'line-c', 'line-d'])
    expect(timeline.activeOwnedLines.map((line) => line.id)).toEqual(['line-a'])
    expect(timeline.nextOwnedLine?.id).toBe('line-c')
  })

  it('supports spectators with no owned dialogue', () => {
    const timeline = getPlaybackTimeline(lines, 12_000, 7000, new Set())
    expect(timeline.ownedLines).toEqual([])
    expect(timeline.activeOwnedLines).toEqual([])
    expect(timeline.nextOwnedLine).toBeNull()
    expect(timeline.completedLines.map((line) => line.id)).toEqual(['line-a', 'line-b'])
  })

  it('reaches a truthful completed state at canonical duration', () => {
    const timeline = getPlaybackTimeline(lines, 12_000, 12_000, new Set(['a']))
    expect(timeline.progress).toBe(1)
    expect(timeline.activeLines).toEqual([])
    expect(timeline.upcomingLines).toEqual([])
    expect(timeline.completedLines).toHaveLength(lines.length)
  })
})
