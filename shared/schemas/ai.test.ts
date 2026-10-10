import { describe, expect, it } from 'vitest'
import { aiEditableDraftSchema, aiJobEnvelopeSchema, aiWarningCodeSchema } from './ai'

const result = {
  characters: [
    { id: 'speaker-00', name: 'Konuşmacı 1' },
    { id: 'speaker-01', name: 'Konuşmacı 2' },
  ],
  lines: [
    {
      id: 'ai-replik-0001',
      characterId: 'speaker-00',
      text: 'Merhaba.',
      startMs: 0,
      endMs: 800,
    },
  ],
  analysis: {
    source: 'local-ai',
    transcriptionModel: 'small',
    diarizationModel: 'pyannote/speaker-diarization-community-1',
    device: 'cpu',
    detectedLanguage: 'tr',
    languageProbability: 0.88,
    lineAnalysis: [
      {
        lineId: 'ai-replik-0001',
        detectedSpeakerId: 'SPEAKER_00',
        transcriptLogProbability: -0.24,
        diarizationConfidence: null,
        warningCodes: ['overlapping_speech'],
      },
    ],
    warnings: [
      {
        code: 'overlapping_speech',
        message: 'Üst üste konuşma algılandı.',
        severity: 'warning',
        lineId: 'ai-replik-0001',
        startMs: 0,
        endMs: 800,
      },
    ],
  },
} as const

describe('local AI contracts', () => {
  it('preserves model-provided values and nullable diarization confidence', () => {
    expect(aiEditableDraftSchema.parse(result).analysis.lineAnalysis[0]).toMatchObject({
      transcriptLogProbability: -0.24,
      diarizationConfidence: null,
    })
  })

  it('requires explicit nullable lifecycle fields and validates stable job responses', () => {
    expect(
      aiJobEnvelopeSchema.safeParse({
        job: {
          id: 'b48e35b0-1f16-4f23-8626-53f17b7f8101',
          status: 'succeeded',
          stage: 'building_draft',
          result,
          error: null,
        },
      }).success,
    ).toBe(true)
  })

  it('accepts the truthful speaker-stabilization fallback warning', () => {
    expect(aiWarningCodeSchema.parse('speaker_stabilization_failed')).toBe(
      'speaker_stabilization_failed',
    )
  })
})
