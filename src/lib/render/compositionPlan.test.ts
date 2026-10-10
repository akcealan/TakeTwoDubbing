import { describe, expect, it } from 'vitest'
import { recordingManifestSchema } from '../../../shared/schemas/recording'
import { buildCompositionPlan, type SourceProbe } from './compositionPlan'

const probe: SourceProbe = { codecName: 'vp8', pixelFormat: 'yuv420p', durationMs: 30_000 }

function manifest(
  options: { background?: boolean; starts?: number[]; captureStarts?: number[] } = {},
) {
  const starts = options.starts ?? [1_000, 5_000, 9_500]
  return recordingManifestSchema.parse({
    version: 1,
    manifestId: '00000000-0000-4000-8000-000000000010',
    roomId: '00000000-0000-4000-8000-000000000001',
    sceneId: 'a-small-step',
    sourceVideoUrl: '/scenes/a-small-step/video.webm',
    ...(options.background ? { backgroundAudioUrl: '/scenes/a-small-step/background.ogg' } : {}),
    sceneDurationMs: 30_000,
    createdAt: 1,
    entries: starts.map((startMs, index) => ({
      lineId: `line-${index + 1}`,
      characterId: `character-${index + 1}`,
      playerId: `00000000-0000-4000-8000-00000000000${index + 2}`,
      startMs,
      endMs: Math.min(startMs + 3_000, 30_000),
      ...(options.captureStarts?.[index] === undefined
        ? {}
        : {
            captureStartMs: options.captureStarts[index],
            captureEndMs: Math.min(startMs + 3_500, 30_000),
          }),
      recordingId: `00000000-0000-4000-8000-00000000010${index}`,
      mimeType: index === 1 ? 'audio/ogg;codecs=opus' : 'audio/webm;codecs=opus',
      byteSize: 100,
      durationMs: 1_500,
    })),
  })
}

describe('frozen-manifest composition plan', () => {
  it('uses every and only frozen manifest recording in canonical order', () => {
    const input = manifest()
    const plan = buildCompositionPlan(input, probe)
    expect(plan.audioInputPaths).toEqual([
      '/inputs/recording-0.webm',
      '/inputs/recording-1.ogg',
      '/inputs/recording-2.webm',
    ])
    expect(plan.audioMixCommand.filter((argument) => argument === '-i')).toHaveLength(3)
    expect(plan.audioMixCommand.join(' ')).not.toContain(input.sourceVideoUrl)
  })

  it('excludes original source audio when no prepared background exists', () => {
    const plan = buildCompositionPlan(manifest(), probe)
    expect(plan.audioMixCommand.join(' ')).not.toContain('source.webm')
    expect(plan.videoCommand).toContain('0:v:0')
    expect(plan.videoCommand).not.toContain('0:a:0')
    expect(plan.videoCommand).toContain('1:a:0')
  })

  it('includes prepared background at a conservative level when present', () => {
    const plan = buildCompositionPlan(manifest({ background: true }), probe)
    expect(plan.audioInputPaths[0]).toBe('/inputs/background.ogg')
    expect(plan.audioMixCommand.join(' ')).toContain('volume=0.35[background]')
    expect(plan.audioMixCommand.join(' ')).toContain('amix=inputs=4')
  })

  it('treats the secure room background route as M4A from scene time zero', () => {
    const input = manifest({ background: true })
    input.backgroundAudioUrl = '/api/rooms/012345/render-background'
    const plan = buildCompositionPlan(input, probe)
    expect(plan.audioInputPaths[0]).toBe('/inputs/background.m4a')
    const filter = plan.audioMixCommand[plan.audioMixCommand.indexOf('-filter_complex') + 1]
    expect(filter).toContain('asetpts=PTS-STARTPTS')
    expect(filter).toContain('apad=whole_dur=30')
    expect(filter).toContain('atrim=duration=30')
    expect(plan.videoCommand).toContain('0:v:0')
    expect(plan.videoCommand).not.toContain('0:a:0')
  })

  it('places overlapping multi-character recordings at their millisecond starts', () => {
    const plan = buildCompositionPlan(manifest({ starts: [1_250, 1_250, 4_875] }), probe)
    const filter = plan.audioMixCommand[plan.audioMixCommand.indexOf('-filter_complex') + 1]
    expect(filter).toContain('adelay=1250:all=1')
    expect(filter?.match(/adelay=1250:all=1/g)).toHaveLength(2)
    expect(filter).toContain('adelay=4875:all=1')
    expect(filter).toContain('amix=inputs=3:duration=longest')
    expect(filter).toContain('alimiter=limit=0.95')
  })

  it('places grace-window audio at capture start without an artificial late shift', () => {
    const plan = buildCompositionPlan(manifest({ starts: [10_000], captureStarts: [9_500] }), probe)
    const filter = plan.audioMixCommand[plan.audioMixCommand.indexOf('-filter_complex') + 1]
    expect(filter).toContain('adelay=9500:all=1')
    expect(filter).not.toContain('adelay=10000:all=1')
  })

  it('falls back to canonical start for a legacy manifest entry', () => {
    const plan = buildCompositionPlan(manifest({ starts: [10_000] }), probe)
    const filter = plan.audioMixCommand[plan.audioMixCommand.indexOf('-filter_complex') + 1]
    expect(filter).toContain('adelay=10000:all=1')
  })

  it('stream-copies only a probed browser-safe H.264 source', () => {
    const safe = buildCompositionPlan(manifest(), {
      codecName: 'h264',
      pixelFormat: 'yuv420p',
      durationMs: 30_000,
    })
    expect(safe.copySourceVideo).toBe(true)
    expect(safe.videoCommand).toContain('copy')
    const vp8 = buildCompositionPlan(manifest(), probe)
    expect(vp8.copySourceVideo).toBe(false)
    expect(vp8.videoCommand).toContain('libx264')
  })

  it('accepts the mounted source extension for an extensionless private route', () => {
    const input = manifest()
    input.sourceVideoUrl = '/api/rooms/012345/source-video'
    const plan = buildCompositionPlan(input, probe, 'mp4')
    expect(plan.sourcePath).toBe('/inputs/source.mp4')
    expect(plan.videoCommand).toContain('/inputs/source.mp4')
  })
})
