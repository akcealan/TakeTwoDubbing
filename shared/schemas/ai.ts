import { z } from 'zod'
import { characterSchema, dialogueLineSchema } from './scene'

export const aiStageSchema = z.enum([
  'queued',
  'preparing_audio',
  'transcribing',
  'diarizing',
  'merging',
  'building_draft',
])

export const aiWarningCodeSchema = z.enum([
  'low_transcription_confidence',
  'uncertain_speaker',
  'overlapping_speech',
  'very_short_line',
  'timing_review',
  'speaker_stabilization_failed',
  'speech_not_detected',
])

export const aiWarningSchema = z.strictObject({
  code: aiWarningCodeSchema,
  message: z.string().trim().min(1).max(500),
  severity: z.enum(['info', 'warning']),
  lineId: z.string().nullable().default(null),
  startMs: z.number().int().nonnegative().nullable().default(null),
  endMs: z.number().int().nonnegative().nullable().default(null),
})

export const aiLineAnalysisSchema = z.strictObject({
  lineId: z.string(),
  detectedSpeakerId: z.string().regex(/^SPEAKER_(?:\d{2,}|UNKNOWN)$/),
  transcriptLogProbability: z.number().finite().nullable().default(null),
  diarizationConfidence: z.number().min(0).max(1).nullable().default(null),
  warningCodes: z.array(aiWarningCodeSchema).default([]),
})

export const aiAnalysisSchema = z.strictObject({
  source: z.literal('local-ai'),
  transcriptionModel: z.string().trim().min(1),
  diarizationModel: z.string().trim().min(1),
  device: z.enum(['cpu', 'cuda']),
  detectedLanguage: z.string().trim().min(1).nullable(),
  languageProbability: z.number().min(0).max(1).nullable(),
  lineAnalysis: z.array(aiLineAnalysisSchema),
  warnings: z.array(aiWarningSchema),
})

export const aiEditableDraftSchema = z.strictObject({
  characters: z.array(characterSchema),
  lines: z.array(dialogueLineSchema),
  analysis: aiAnalysisSchema,
})

export const aiHealthIssueSchema = z.strictObject({
  code: z.enum(['dependencies_missing', 'models_missing', 'model_access_missing']),
  message: z.string().trim().min(1),
})

export const aiHealthSchema = z.strictObject({
  service: z.literal('take-two-local-ai'),
  version: z.string(),
  status: z.enum(['ready', 'setup_required']),
  device: z.enum(['cpu', 'cuda']),
  transcriptionModel: z.string(),
  diarizationModel: z.string(),
  issues: z.array(aiHealthIssueSchema),
})

export const aiJobSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  stage: aiStageSchema,
  result: aiEditableDraftSchema.nullable(),
  error: z.string().nullable(),
})

export const aiJobEnvelopeSchema = z.strictObject({ job: aiJobSchema })

export const separationStageSchema = z.enum(['queued', 'loading_model', 'separating', 'encoding'])

export const separationHealthSchema = z.strictObject({
  service: z.literal('take-two-local-ai'),
  status: z.enum(['ready', 'setup_required']),
  provider: z.string().trim().min(1),
  requestedDevice: z.enum(['auto', 'cpu', 'cuda']),
  issues: z.array(
    z.strictObject({
      code: z.enum(['environment_missing', 'model_missing', 'model_checksum_invalid']),
      message: z.string().trim().min(1),
    }),
  ),
})

export const separationResultSchema = z.strictObject({
  mimeType: z.literal('audio/mp4'),
  byteSize: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  channels: z.literal(2),
  provider: z.string().trim().min(1),
  providerVersion: z.string().trim().min(1),
  model: z.string().trim().min(1),
  device: z.enum(['cpu', 'cuda']),
  inferenceSeconds: z.number().nonnegative(),
  warnings: z.array(z.string()),
})

export const separationJobSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  stage: separationStageSchema,
  result: separationResultSchema.nullable(),
  error: z.string().nullable(),
})

export const separationJobEnvelopeSchema = z.strictObject({ job: separationJobSchema })
