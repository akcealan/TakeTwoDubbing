import { describe, expect, it } from 'vitest'
import { storedRecordingSchema } from '../../../shared/schemas/recording'
import type { Room, Scene } from '../../../shared/types'
import { buildRecordingManifest } from '../../../worker/domain/recordingCompletion'
import { buildCompositionPlan } from '../render/compositionPlan'
import { getGuidedAttemptPlan } from './guidedTiming'

const playerId = '00000000-0000-4000-8000-000000000001'

const scene: Scene = {
  id: 'timing-regression',
  title: 'Zamanlama regresyonu',
  description: '',
  durationMs: 15_000,
  videoUrl: '/scenes/a-small-step/video.webm',
  genre: 'Custom',
  difficulty: 'Prepared',
  accent: 'violet',
  mediaStatus: 'available',
  sourceAudioStatus: 'silent',
  contentCredit: 'Test fixture',
  origin: { kind: 'built-in', version: 1 },
  characters: [{ id: 'speaker', name: 'Konuşmacı' }],
  lines: [
    { id: 'near-zero', characterId: 'speaker', text: 'Başla', startMs: 100, endMs: 900 },
    {
      id: 'tight-line',
      characterId: 'speaker',
      text: 'Müsait misin?',
      startMs: 5_000,
      endMs: 5_850,
    },
  ],
}

describe('guided dubbing timing pipeline regression', () => {
  it('preserves full countdown, accepted grace metadata, manifest timing and render placement', () => {
    const firstPlan = getGuidedAttemptPlan(scene.lines[0]!, scene.durationMs)
    const tightPlan = getGuidedAttemptPlan(scene.lines[1]!, scene.durationMs)
    expect(firstPlan).toMatchObject({ preparationHoldMs: 2_900, captureStartMs: 0 })
    expect(tightPlan).toMatchObject({
      captureStartMs: 4_500,
      captureEndMs: 6_350,
    })
    expect(tightPlan.captureEndMs - tightPlan.captureStartMs).toBeGreaterThan(
      scene.lines[1]!.endMs - scene.lines[1]!.startMs,
    )

    const recordings = scene.lines.map((line, index) => {
      const plan = getGuidedAttemptPlan(line, scene.durationMs)
      return storedRecordingSchema.parse({
        recordingId: `00000000-0000-4000-8000-00000000010${index}`,
        lineId: line.id,
        playerId,
        mimeType: 'audio/webm;codecs=opus',
        byteSize: 100,
        durationMs: plan.captureEndMs - plan.captureStartMs,
        captureStartMs: plan.captureStartMs,
        captureEndMs: plan.captureEndMs,
        uploadedAt: 1,
      })
    })
    const room: Room = {
      id: '00000000-0000-4000-8000-000000000010',
      code: '012345',
      sceneId: scene.id,
      sceneSnapshot: scene,
      hostId: playerId,
      status: 'playing',
      startedAt: 1,
      players: [
        {
          id: playerId,
          nickname: 'Oyuncu',
          connected: true,
          ready: true,
          characterIds: ['speaker'],
        },
      ],
      recordings,
      recordingManifest: null,
      expiresAt: 10_000,
      revision: 1,
    }
    const manifest = buildRecordingManifest(room, scene, '00000000-0000-4000-8000-000000000020', 2)
    expect(
      manifest.entries.map(({ startMs, endMs, captureStartMs, captureEndMs }) => ({
        startMs,
        endMs,
        captureStartMs,
        captureEndMs,
      })),
    ).toEqual([
      { startMs: 100, endMs: 900, captureStartMs: 0, captureEndMs: 1_400 },
      { startMs: 5_000, endMs: 5_850, captureStartMs: 4_500, captureEndMs: 6_350 },
    ])

    const plan = buildCompositionPlan(manifest, {
      codecName: 'vp8',
      pixelFormat: 'yuv420p',
      durationMs: scene.durationMs,
    })
    const filter = plan.audioMixCommand[plan.audioMixCommand.indexOf('-filter_complex') + 1]
    expect(filter).toContain('adelay=0:all=1')
    expect(filter).toContain('adelay=4500:all=1')
    expect(filter).not.toContain('adelay=5000:all=1')
  })
})
