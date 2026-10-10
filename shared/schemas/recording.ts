import { z } from 'zod'

export const ALLOWED_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
] as const

export const MAX_RECORDING_BYTES = 5 * 1024 * 1024
export const MAX_RECORDING_DURATION_MS = 120_000

export const recordingMimeTypeSchema = z.enum(ALLOWED_RECORDING_MIME_TYPES)
export const recordingIdSchema = z.uuid()
export const recordingManifestIdSchema = z.uuid()
export const recordingLineIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

const captureTimingFields = {
  captureStartMs: z.number().int().nonnegative().optional(),
  captureEndMs: z.number().int().positive().optional(),
}

function hasCompleteCaptureTiming(value: { captureStartMs?: number; captureEndMs?: number }) {
  return (value.captureStartMs === undefined) === (value.captureEndMs === undefined)
}

export const storedRecordingSchema = z
  .strictObject({
    recordingId: recordingIdSchema,
    lineId: recordingLineIdSchema,
    playerId: z.uuid(),
    mimeType: recordingMimeTypeSchema,
    byteSize: z.number().int().positive().max(MAX_RECORDING_BYTES),
    durationMs: z.number().int().nonnegative().max(MAX_RECORDING_DURATION_MS),
    uploadedAt: z.number().int().nonnegative(),
    ...captureTimingFields,
  })
  .superRefine((recording, context) => {
    if (!hasCompleteCaptureTiming(recording))
      context.addIssue({ code: 'custom', message: 'Capture timing must include both boundaries.' })
    if (
      recording.captureStartMs !== undefined &&
      recording.captureEndMs !== undefined &&
      recording.captureEndMs <= recording.captureStartMs
    )
      context.addIssue({ code: 'custom', message: 'Capture timing is invalid.' })
  })

export const recordingUploadAuthorizationSchema = z.strictObject({
  roomId: z.uuid(),
  playerId: z.uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  recordingId: recordingIdSchema,
  durationMs: z.number().int().nonnegative().max(MAX_RECORDING_DURATION_MS),
})

export const recordingUploadMetadataSchema = z
  .strictObject({
    recordingId: recordingIdSchema,
    durationMs: z.number().int().nonnegative().max(MAX_RECORDING_DURATION_MS),
    ...captureTimingFields,
  })
  .superRefine((metadata, context) => {
    if (!hasCompleteCaptureTiming(metadata))
      context.addIssue({ code: 'custom', message: 'Capture timing must include both boundaries.' })
  })

export const recordingUploadResponseSchema = z.strictObject({
  recording: storedRecordingSchema,
})

export const playerRecordingProgressSchema = z
  .strictObject({
    playerId: z.uuid(),
    required: z.number().int().nonnegative(),
    uploaded: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    complete: z.boolean(),
    spectator: z.boolean(),
  })
  .refine(
    (progress) =>
      progress.uploaded <= progress.required &&
      progress.remaining === progress.required - progress.uploaded &&
      progress.complete === (progress.remaining === 0) &&
      progress.spectator === (progress.required === 0),
    { message: 'Player recording progress is inconsistent.' },
  )

export const roomRecordingProgressSchema = z
  .strictObject({
    totalRequired: z.number().int().nonnegative(),
    totalUploaded: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    readyForFinalization: z.boolean(),
    players: z.array(playerRecordingProgressSchema),
  })
  .refine(
    (progress) =>
      progress.totalUploaded <= progress.totalRequired &&
      progress.remaining === progress.totalRequired - progress.totalUploaded &&
      progress.readyForFinalization === (progress.totalRequired > 0 && progress.remaining === 0),
    { message: 'Room recording progress is inconsistent.' },
  )

export const recordingManifestEntrySchema = z
  .strictObject({
    lineId: recordingLineIdSchema,
    characterId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    playerId: z.uuid(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    recordingId: recordingIdSchema,
    mimeType: recordingMimeTypeSchema,
    byteSize: z.number().int().positive().max(MAX_RECORDING_BYTES),
    durationMs: z.number().int().nonnegative().max(MAX_RECORDING_DURATION_MS),
    ...captureTimingFields,
  })
  .refine((entry) => entry.endMs > entry.startMs, {
    message: 'Manifest line timing is invalid.',
  })
  .superRefine((entry, context) => {
    if (!hasCompleteCaptureTiming(entry))
      context.addIssue({ code: 'custom', message: 'Capture timing must include both boundaries.' })
    if (
      entry.captureStartMs !== undefined &&
      entry.captureEndMs !== undefined &&
      (entry.captureStartMs > entry.startMs ||
        entry.captureEndMs < entry.endMs ||
        entry.captureEndMs <= entry.captureStartMs)
    )
      context.addIssue({ code: 'custom', message: 'Manifest capture timing is invalid.' })
  })

export const recordingManifestSchema = z
  .strictObject({
    version: z.literal(1),
    manifestId: recordingManifestIdSchema,
    roomId: z.uuid(),
    sceneId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    sourceVideoUrl: z.string().min(1).max(500),
    backgroundAudioUrl: z.string().min(1).max(500).optional(),
    sceneDurationMs: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    entries: z.array(recordingManifestEntrySchema).min(1),
  })
  .refine(
    (manifest) =>
      new Set(manifest.entries.map((entry) => entry.lineId)).size === manifest.entries.length,
    { message: 'Manifest line IDs must be unique.' },
  )
  .superRefine((manifest, context) => {
    manifest.entries.forEach((entry, index) => {
      if (entry.captureEndMs !== undefined && entry.captureEndMs > manifest.sceneDurationMs)
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'captureEndMs'],
          message: 'Manifest capture timing exceeds the scene duration.',
        })
    })
  })
