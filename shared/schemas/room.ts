import { z } from 'zod'
import {
  recordingManifestSchema,
  roomRecordingProgressSchema,
  storedRecordingSchema,
} from './recording'
import { storedRoomResultSchema } from './result'
import { sceneSchema } from './scene'

export const MAX_PLAYERS = 12
export const roomCodeSchema = z.string().regex(/^\d{6}$/, 'Tam 6 rakam gir.')
export const nicknameSchema = z
  .string()
  .trim()
  .min(2, 'En az 2 karakter kullan.')
  .max(20, 'En fazla 20 karakter kullan.')
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u,
    'Harf, rakam, boşluk, kısa çizgi veya alt çizgi kullan.',
  )

export const playerSchema = z.object({
  id: z.string().min(1),
  nickname: nicknameSchema,
  connected: z.boolean(),
  ready: z.boolean(),
  characterIds: z.array(z.string().min(1)),
})

export const roomStatusSchema = z.enum(['lobby', 'playing', 'recording', 'processing', 'finished'])
export const roomSchema = z
  .object({
    id: z.string().min(1),
    code: roomCodeSchema,
    sceneId: z.string().min(1),
    sceneSnapshot: sceneSchema.optional(),
    hostId: z.string().min(1),
    status: roomStatusSchema,
    startedAt: z.number().int().nonnegative().nullable(),
    players: z.array(playerSchema),
    recordings: z.array(storedRecordingSchema).optional(),
    recordingProgress: roomRecordingProgressSchema.optional(),
    recordingManifest: recordingManifestSchema.nullable().optional(),
    result: storedRoomResultSchema.nullable().optional(),
    expiresAt: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  })
  .superRefine((room, context) => {
    if (room.status === 'lobby' && room.startedAt !== null)
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'A lobby cannot have a start time.',
      })
    if (room.status !== 'lobby' && room.startedAt === null)
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'A started room requires a start time.',
      })
    if ((room.status === 'processing' || room.status === 'finished') && !room.recordingManifest)
      context.addIssue({
        code: 'custom',
        path: ['recordingManifest'],
        message: 'A processing room requires a frozen recording manifest.',
      })
    if (room.status === 'finished' && !room.result)
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'A finished room requires a committed result.',
      })
    if (
      room.result &&
      (room.result.roomId !== room.id ||
        room.result.manifestId !== room.recordingManifest?.manifestId)
    )
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'The committed result must match its room and frozen manifest.',
      })
    const recordingLineIds = room.recordings?.map((recording) => recording.lineId) ?? []
    if (new Set(recordingLineIds).size !== recordingLineIds.length)
      context.addIssue({
        code: 'custom',
        path: ['recordings'],
        message: 'A room can expose only one stored recording per line.',
      })
  })

export const createRoomSchema = z.strictObject({
  sceneId: z.string().min(1).max(100),
  nickname: nicknameSchema,
})
export const joinRoomRequestSchema = z.strictObject({
  nickname: nicknameSchema,
  requestId: z.uuid(),
  requestToken: z.string().regex(/^[a-f0-9]{64}$/),
})
export const sessionSchema = z.strictObject({
  code: roomCodeSchema,
  roomId: z.uuid(),
  playerId: z.uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
})
export const roomSummarySchema = z.object({
  id: z.string().min(1),
  code: roomCodeSchema,
  sceneId: z.string().min(1),
  status: roomStatusSchema,
  expiresAt: z.number().int().nonnegative(),
  playerCount: z.number().int().min(0).max(MAX_PLAYERS),
})
