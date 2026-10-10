import { z } from 'zod'

export const FINAL_RESULT_MIME_TYPE = 'video/mp4' as const
// Deliberately below Cloudflare Free's 100 MB edge request cap. The Worker streams
// this body into bounded SQLite Durable Object chunks after authorization instead of
// buffering it in 128 MB isolate memory.
export const MAX_FINAL_RESULT_BYTES = 64 * 1024 * 1024

export const resultIdSchema = z.uuid()

export const storedRoomResultSchema = z.strictObject({
  resultId: resultIdSchema,
  manifestId: z.uuid(),
  roomId: z.uuid(),
  mimeType: z.literal(FINAL_RESULT_MIME_TYPE),
  byteSize: z.number().int().positive().max(MAX_FINAL_RESULT_BYTES),
  completedAt: z.number().int().nonnegative(),
  filename: z.string().min(1).max(160),
})

export const resultUploadMetadataSchema = z.strictObject({
  resultId: resultIdSchema,
  manifestId: z.uuid(),
})

export const resultUploadResponseSchema = z.strictObject({
  result: storedRoomResultSchema,
})
