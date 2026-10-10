import type { z } from 'zod'
import type { characterSchema, dialogueLineSchema, sceneSchema } from '../schemas/scene'
import type { playerSchema, roomSchema, roomStatusSchema } from '../schemas/room'
import type {
  recordingManifestSchema,
  roomRecordingProgressSchema,
  storedRecordingSchema,
} from '../schemas/recording'
import type { storedRoomResultSchema } from '../schemas/result'
import type {
  backgroundAssetSchema,
  preparationDraftSchema,
  thumbnailAssetSchema,
  uploadedMediaSchema,
} from '../schemas/studio'
import type {
  aiAnalysisSchema,
  aiEditableDraftSchema,
  aiHealthSchema,
  aiJobSchema,
  aiWarningSchema,
  separationHealthSchema,
  separationJobSchema,
  separationResultSchema,
} from '../schemas/ai'

export type Character = z.infer<typeof characterSchema>
export type DialogueLine = z.infer<typeof dialogueLineSchema>
export type Scene = z.infer<typeof sceneSchema>
export type Player = z.infer<typeof playerSchema>
export type Room = z.infer<typeof roomSchema>
export type RoomStatus = z.infer<typeof roomStatusSchema>
export type StoredRecording = z.infer<typeof storedRecordingSchema>
export type RoomRecordingProgress = z.infer<typeof roomRecordingProgressSchema>
export type RecordingManifest = z.infer<typeof recordingManifestSchema>
export type StoredRoomResult = z.infer<typeof storedRoomResultSchema>
export type UploadedMedia = z.infer<typeof uploadedMediaSchema>
export type PreparationDraft = z.infer<typeof preparationDraftSchema>
export type BackgroundAsset = z.infer<typeof backgroundAssetSchema>
export type ThumbnailAsset = z.infer<typeof thumbnailAssetSchema>
export type AiAnalysis = z.infer<typeof aiAnalysisSchema>
export type AiEditableDraft = z.infer<typeof aiEditableDraftSchema>
export type AiHealth = z.infer<typeof aiHealthSchema>
export type AiJob = z.infer<typeof aiJobSchema>
export type AiWarning = z.infer<typeof aiWarningSchema>
export type SeparationHealth = z.infer<typeof separationHealthSchema>
export type SeparationJob = z.infer<typeof separationJobSchema>
export type SeparationResult = z.infer<typeof separationResultSchema>
