import { z } from 'zod'
import { roomSchema, sessionSchema } from './room'

export const MAX_MESSAGE_BYTES = 4096
export const errorCodeSchema = z.enum([
  'INVALID_INPUT',
  'INVALID_MESSAGE',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'NICKNAME_TAKEN',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'ORIGIN_DENIED',
  'SESSION_REPLACED',
  'SERVER_ERROR',
  'ROOM_UNAVAILABLE',
  'FORBIDDEN',
  'UNSUPPORTED_MEDIA',
  'UPLOAD_TOO_LARGE',
  'UPLOAD_FAILED',
  'LINE_NOT_OWNED',
  'RECORDINGS_INCOMPLETE',
  'FINALIZATION_STARTED',
  'RECORDING_NOT_FOUND',
  'RESULT_NOT_FOUND',
  'RESULT_ALREADY_COMMITTED',
])
export const apiErrorSchema = z.object({ code: errorCodeSchema, message: z.string() })
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('AUTH'), session: sessionSchema }),
  z.strictObject({ type: z.literal('PLAYER_READY'), ready: z.boolean() }),
  z.strictObject({ type: z.literal('START_GAME') }),
  z.strictObject({ type: z.literal('FINALIZE_RECORDINGS') }),
  z.strictObject({ type: z.literal('LEAVE_ROOM') }),
  z.strictObject({ type: z.literal('PING') }),
])
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ROOM_STATE'), payload: roomSchema }),
  z.strictObject({ type: z.literal('ERROR'), payload: apiErrorSchema }),
  z.strictObject({ type: z.literal('LEFT_ROOM') }),
  z.strictObject({ type: z.literal('PONG') }),
])

export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>
export type ErrorCode = z.infer<typeof errorCodeSchema>
export type RoomSession = z.infer<typeof sessionSchema>
