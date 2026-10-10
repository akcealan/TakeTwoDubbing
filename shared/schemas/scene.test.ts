import { describe, expect, it } from 'vitest'
import { getSceneById, scenes } from '../scenes/catalog'
import { sceneCatalogSchema, sceneSchema } from './scene'

const scene = getSceneById('a-small-step')!

describe('original scene catalog', () => {
  it('contains valid scenes with truthful playable and placeholder media states', () => {
    expect(sceneCatalogSchema.safeParse(scenes).success).toBe(true)
    expect(scenes.length).toBeGreaterThanOrEqual(2)
    expect(getSceneById('a-small-step')).toMatchObject({
      mediaStatus: 'available',
      videoUrl: '/scenes/a-small-step/video.webm',
    })
    expect(getSceneById('the-last-table')?.mediaStatus).toBe('placeholder')
  })
  it('looks up known scenes and returns undefined for missing IDs', () => {
    expect(getSceneById('a-small-step')?.title).toBe('Küçük Bir Adım')
    expect(getSceneById('missing')).toBeUndefined()
    expect(getSceneById(undefined)).toBeUndefined()
  })
  it('rejects duplicate scene and character IDs', () => {
    expect(sceneCatalogSchema.safeParse([scene, scene]).success).toBe(false)
    expect(
      sceneSchema.safeParse({ ...scene, characters: [scene.characters[0], scene.characters[0]] })
        .success,
    ).toBe(false)
  })
  it('rejects duplicate lines and unknown character references', () => {
    expect(
      sceneSchema.safeParse({ ...scene, lines: [scene.lines[0], scene.lines[0]] }).success,
    ).toBe(false)
    expect(
      sceneSchema.safeParse({ ...scene, lines: [{ ...scene.lines[0], characterId: 'unknown' }] })
        .success,
    ).toBe(false)
  })
  it.each([
    { startMs: -1, endMs: 1000 },
    { startMs: 1000.5, endMs: 2000 },
    { startMs: 1000, endMs: 1000 },
    { startMs: 2000, endMs: 1000 },
    { startMs: 1000, endMs: 30001 },
  ])('rejects invalid timeline boundaries: %o', (times) => {
    expect(
      sceneSchema.safeParse({ ...scene, lines: [{ ...scene.lines[0], ...times }] }).success,
    ).toBe(false)
  })
  it('rejects non-local media and empty scripts', () => {
    expect(
      sceneSchema.safeParse({ ...scene, videoUrl: 'https://unapproved.example/video.mp4' }).success,
    ).toBe(false)
    expect(sceneSchema.safeParse({ ...scene, lines: [] }).success).toBe(false)
  })
})
