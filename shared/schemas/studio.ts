import { z } from 'zod'
import { sceneSchema } from './scene'
import { aiAnalysisSchema } from './ai'

export const MAX_PRIVATE_SCENE_BYTES = 25 * 1024 * 1024
export const MAX_PRIVATE_SCENE_DURATION_MS = 10 * 60 * 1000
export const ALLOWED_PRIVATE_VIDEO_TYPES = ['video/webm', 'video/mp4'] as const
export const BACKGROUND_AUDIO_MIME_TYPE = 'audio/mp4' as const
export const MAX_BACKGROUND_AUDIO_BYTES = 20 * 1024 * 1024
export const ALLOWED_THUMBNAIL_TYPES = ['image/webp', 'image/jpeg'] as const
export const MAX_THUMBNAIL_BYTES = 512 * 1024
export const MAX_THUMBNAIL_DIMENSION = 640

export const studioTokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const privateVideoMimeSchema = z.enum(ALLOWED_PRIVATE_VIDEO_TYPES)
export const thumbnailMimeSchema = z.enum(ALLOWED_THUMBNAIL_TYPES)

export const uploadedMediaSchema = z.strictObject({
  sceneId: z.string().regex(/^private-[a-f0-9]{12}$/),
  filename: z.string().trim().min(1).max(255),
  mimeType: privateVideoMimeSchema,
  byteSize: z.number().int().positive().max(MAX_PRIVATE_SCENE_BYTES),
  durationMs: z.number().int().positive().max(MAX_PRIVATE_SCENE_DURATION_MS),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  uploadedAt: z.number().int().nonnegative(),
})

export const backgroundPreparationSchema = z.strictObject({
  provider: z.string().trim().min(1).max(80),
  providerVersion: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  device: z.enum(['cpu', 'cuda']),
})

export const backgroundAssetSchema = z.strictObject({
  id: z.uuid(),
  mimeType: z.literal(BACKGROUND_AUDIO_MIME_TYPE),
  byteSize: z.number().int().positive().max(MAX_BACKGROUND_AUDIO_BYTES),
  durationMs: z.number().int().positive().max(MAX_PRIVATE_SCENE_DURATION_MS),
  sampleRate: z.number().int().min(8_000).max(192_000),
  channels: z.literal(2),
  createdAt: z.number().int().nonnegative(),
  preparation: backgroundPreparationSchema,
})

export const thumbnailAssetSchema = z.strictObject({
  id: z.uuid(),
  mimeType: thumbnailMimeSchema,
  byteSize: z.number().int().positive().max(MAX_THUMBNAIL_BYTES),
  width: z.number().int().positive().max(MAX_THUMBNAIL_DIMENSION),
  height: z.number().int().positive().max(MAX_THUMBNAIL_DIMENSION),
  capturedAtMs: z.number().int().nonnegative().max(MAX_PRIVATE_SCENE_DURATION_MS),
  createdAt: z.number().int().nonnegative(),
})

export const preparationDraftSchema = z.strictObject({
  media: uploadedMediaSchema,
  scene: sceneSchema.nullable(),
  backgroundAudio: backgroundAssetSchema.optional(),
  thumbnail: thumbnailAssetSchema.optional(),
  status: z.enum(['draft', 'prepared']),
  warnings: z.array(z.string().max(500)).default([]),
  aiAnalysis: aiAnalysisSchema.optional(),
})

export const sceneListResponseSchema = z.strictObject({ scenes: z.array(sceneSchema) })
export const preparationDraftResponseSchema = z.strictObject({ draft: preparationDraftSchema })
export const savePreparedSceneSchema = z.strictObject({ scene: sceneSchema })
