import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import { createRoomSchema, joinRoomRequestSchema, MAX_PLAYERS } from '../../shared/schemas/room'
import { sessionSchema } from '../../shared/schemas/room'
import {
  MAX_RECORDING_BYTES,
  recordingIdSchema,
  recordingManifestIdSchema,
  recordingManifestSchema,
  recordingMimeTypeSchema,
  recordingUploadMetadataSchema,
} from '../../shared/schemas/recording'
import {
  FINAL_RESULT_MIME_TYPE,
  MAX_FINAL_RESULT_BYTES,
  resultIdSchema,
  storedRoomResultSchema,
  resultUploadMetadataSchema,
} from '../../shared/schemas/result'
import {
  clientMessageSchema,
  MAX_MESSAGE_BYTES,
  type RoomSession,
  type ServerMessage,
} from '../../shared/schemas/protocol'
import {
  newPlayer,
  addPlayer,
  updatePresence,
  removePlayer,
  setReady,
  chooseHost,
  startGame,
} from '../domain/room'
import { getSceneById, resolveRoomScene } from '../../shared/scenes/catalog'
import { sceneSchema } from '../../shared/schemas/scene'
import { RoomError } from '../domain/errors'
import { deriveRecordingProgress, finalizeRecordings } from '../domain/recordingCompletion'
import { RoomStore, type StoredRoom } from '../storage/roomStore'
import { MediaStoreClient, MediaStoreError, publicMediaResponse } from '../storage/mediaStore'
import { createToken, hashToken } from '../lib/tokens'
import { errorResponse, json, readJson, requireContentLength } from '../lib/http'
import type { Env } from '../types/env'
import { getRecordingCaptureWindow } from '../../shared/recordingTiming'
import type { StoredRoomResult } from '../../shared/types'

interface Connection {
  playerId: string | null
  roomId: string
  authDeadline: number
  windowStart: number
  messageCount: number
}

const internalCreateRoomSchema = createRoomSchema.extend({
  roomId: z.uuid(),
  sceneSnapshot: sceneSchema,
  sceneSourceAssetId: z.uuid().optional(),
  sceneBackgroundAssetId: z.uuid().optional(),
})

export class GameRoom extends DurableObject<Env> {
  private state: StoredRoom | null = null
  private readonly store: RoomStore
  private readonly ttl: number

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new RoomStore(ctx.storage)
    this.ttl = Number(env.ROOM_TTL_MS)
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 100)
      throw new Error('Invalid ROOM_TTL_MS configuration')
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"PING"}', '{"type":"PONG"}'),
    )
    ctx.blockConcurrencyWhile(async () => {
      this.state = await this.store.load()
      if (!this.state) return
      this.state.room = stripLegacyObjectKeys(this.state.room)
      this.state.joinRequests ??= {}
      this.state.recordingAssetIds ??= {}
      this.state.room.recordings ??= []
      // Hibernated sockets remain alive; after a runtime restart, stale presence does not.
      let changed = false
      if (this.state.room.startedAt === undefined) {
        this.state.room.startedAt = null
        changed = true
      }
      for (const player of this.state.room.players) {
        const connected = this.sockets().some(
          (socket) => this.connection(socket)?.playerId === player.id,
        )
        if (player.connected !== connected) {
          player.connected = connected
          player.ready = false
          changed = true
        }
      }
      const previousHost = this.state.room.hostId
      chooseHost(this.state.room)
      changed ||= previousHost !== this.state.room.hostId
      const scene = resolveRoomScene(this.state.room)
      if (scene && this.state.room.status === 'playing') {
        this.state.room.recordingProgress = deriveRecordingProgress(this.state.room, scene)
        changed = true
      }
      if (changed) this.state.room.revision++
      await this.store.save(this.state)
      await this.scheduleAlarm()
    })
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const url = new URL(request.url)
        if (url.pathname === '/create' && request.method === 'POST') {
          if (this.state && this.state.room.expiresAt > Date.now())
            return json({ occupied: true }, 409)
          if (this.state) await this.expire()
          const rawInput = await readJson(request)
          const enhancedInput = internalCreateRoomSchema.safeParse(rawInput)
          const input = enhancedInput.success
            ? enhancedInput.data
            : createRoomSchema.parse(rawInput)
          const sceneSnapshot = enhancedInput.success
            ? enhancedInput.data.sceneSnapshot
            : getSceneById(input.sceneId)
          if (!sceneSnapshot)
            throw new RoomError('INVALID_INPUT', 'The selected scene is unavailable.')
          const player = newPlayer(crypto.randomUUID(), input.nickname)
          const token = createToken()
          this.state = {
            version: 1,
            room: {
              id: enhancedInput.success ? enhancedInput.data.roomId : crypto.randomUUID(),
              code: url.searchParams.get('code')!,
              sceneId: input.sceneId,
              sceneSnapshot,
              hostId: player.id,
              status: 'lobby',
              startedAt: null,
              players: [player],
              recordings: [],
              recordingManifest: null,
              result: null,
              expiresAt: Date.now() + this.ttl,
              revision: 0,
            },
            tokenHashes: { [player.id]: await hashToken(token) },
            joinRequests: {},
            sceneSourceAssetId: enhancedInput.success
              ? enhancedInput.data.sceneSourceAssetId
              : undefined,
            sceneBackgroundAssetId: enhancedInput.success
              ? enhancedInput.data.sceneBackgroundAssetId
              : undefined,
            recordingAssetIds: {},
          }
          await this.persist(true)
          return json(this.session(player.id, token), 201)
        }
        const state = await this.requireRoom()
        if (url.pathname === '/source-video' && ['GET', 'HEAD'].includes(request.method)) {
          const session = await this.authorizeSession(state, request)
          if (!state.room.players.some((player) => player.id === session.playerId))
            throw new RoomError('UNAUTHORIZED', 'The player is no longer in this room.', 401)
          if (!state.sceneSourceAssetId || state.room.sceneSnapshot?.origin.kind !== 'private')
            throw new RoomError('RECORDING_NOT_FOUND', 'Private scene media is unavailable.', 404)
          const object = await this.media(state).read(
            state.sceneSourceAssetId,
            request.method as 'GET' | 'HEAD',
            request.headers.get('Range'),
          )
          if (object.status === 404)
            throw new RoomError('RECORDING_NOT_FOUND', 'Private scene media is missing.', 404)
          return publicMediaResponse(object, 'private, no-store')
        }
        if (url.pathname === '/render-background' && ['GET', 'HEAD'].includes(request.method)) {
          const session = await this.authorizeSession(state, request)
          const manifestId = recordingManifestIdSchema.safeParse(
            request.headers.get('X-Manifest-Id'),
          )
          if (!manifestId.success)
            throw new RoomError('INVALID_INPUT', 'The renderer background identity is invalid.')
          if (!state.room.players.some((player) => player.id === session.playerId))
            throw new RoomError('UNAUTHORIZED', 'The player is no longer in this room.', 401)
          if (state.room.status !== 'processing')
            throw new RoomError(
              'ROOM_UNAVAILABLE',
              'Renderer inputs are available only while the room is processing.',
              409,
            )
          const manifest = recordingManifestSchema.safeParse(state.room.recordingManifest)
          const expectedUrl = `/api/rooms/${state.room.code}/render-background`
          if (
            !manifest.success ||
            manifest.data.roomId !== state.room.id ||
            manifest.data.manifestId !== manifestId.data ||
            manifest.data.backgroundAudioUrl !== expectedUrl ||
            !state.sceneBackgroundAssetId
          )
            throw new RoomError(
              'UNAUTHORIZED',
              'The frozen background does not belong to this renderer manifest.',
              401,
            )
          const object = await this.media(state).read(
            state.sceneBackgroundAssetId,
            request.method as 'GET' | 'HEAD',
            request.headers.get('Range'),
          )
          if (object.status === 404)
            throw new RoomError('RECORDING_NOT_FOUND', 'The frozen background is missing.', 404)
          return publicMediaResponse(object, 'private, no-store')
        }
        const resultAuthorizationRoute = /^\/results\/([^/]+)\/authorize-upload$/.exec(url.pathname)
        if (resultAuthorizationRoute && request.method === 'POST') {
          const session = await this.authorizeSession(state, request)
          const resultId = resultIdSchema.safeParse(resultAuthorizationRoute[1])
          const metadata = resultUploadMetadataSchema.safeParse({
            resultId: request.headers.get('X-Result-Id'),
            manifestId: request.headers.get('X-Manifest-Id'),
          })
          if (
            !resultId.success ||
            !metadata.success ||
            metadata.data.resultId !== resultId.data ||
            !state.room.players.some((player) => player.id === session.playerId)
          )
            throw new RoomError('UNAUTHORIZED', 'The result upload is not authorized.', 401)
          const committed = state.room.result
          if (state.room.status === 'finished' && committed) {
            if (
              committed.resultId === metadata.data.resultId &&
              committed.manifestId === metadata.data.manifestId
            )
              return json({ status: 'committed', result: committed })
            throw new RoomError('RESULT_ALREADY_COMMITTED', 'This room already has a result.', 409)
          }
          const manifest = recordingManifestSchema.safeParse(state.room.recordingManifest)
          if (state.room.status !== 'processing')
            throw new RoomError('ROOM_UNAVAILABLE', 'The final result is not expected now.', 409)
          if (
            !manifest.success ||
            manifest.data.roomId !== state.room.id ||
            manifest.data.manifestId !== metadata.data.manifestId
          )
            throw new RoomError(
              'UNAUTHORIZED',
              'The frozen manifest does not match this room.',
              401,
            )
          return json({
            status: 'authorized',
            pending: {
              resultId: metadata.data.resultId,
              manifestId: manifest.data.manifestId,
              roomId: state.room.id,
              mimeType: FINAL_RESULT_MIME_TYPE,
              completedAt: Date.now(),
              filename: `take-two-${state.room.code}.mp4`,
            },
          })
        }
        const resultCommitRoute = /^\/results\/([^/]+)\/commit-upload$/.exec(url.pathname)
        if (resultCommitRoute && request.method === 'POST') {
          const session = await this.authorizeSession(state, request)
          const candidate = storedRoomResultSchema.safeParse(await readJson(request))
          const routeId = resultIdSchema.safeParse(resultCommitRoute[1])
          if (!candidate.success || !routeId.success)
            throw new RoomError('INVALID_INPUT', 'The stored result metadata is invalid.')
          const result = candidate.data
          const assetId = z.uuid().safeParse(request.headers.get('X-Media-Asset-Id'))
          if (
            !assetId.success ||
            result.resultId !== routeId.data ||
            result.roomId !== state.room.id ||
            !state.room.players.some((player) => player.id === session.playerId)
          )
            throw new RoomError(
              'UNAUTHORIZED',
              'The stored result does not belong to this room.',
              401,
            )
          const committed = state.room.result
          if (state.room.status === 'finished' && committed) {
            if (
              committed.resultId === result.resultId &&
              committed.manifestId === result.manifestId
            )
              return json({ result: committed })
            throw new RoomError('RESULT_ALREADY_COMMITTED', 'This room already has a result.', 409)
          }
          const manifest = recordingManifestSchema.safeParse(state.room.recordingManifest)
          if (
            state.room.status !== 'processing' ||
            !manifest.success ||
            manifest.data.manifestId !== result.manifestId
          )
            throw new RoomError('ROOM_UNAVAILABLE', 'The final result is not expected now.', 409)
          const object = await this.media(state).metadata(assetId.data)
          if (
            !object ||
            object.kind !== 'final-result' ||
            object.mimeType !== result.mimeType ||
            object.byteSize !== result.byteSize
          )
            throw new RoomError('UPLOAD_FAILED', 'The uploaded final result is missing.', 503)
          const nextRoom = {
            ...state.room,
            status: 'finished' as const,
            result,
            expiresAt: Date.now() + this.ttl,
            revision: state.room.revision + 1,
          }
          await this.store.save({
            ...state,
            room: nextRoom,
            resultAssetId: assetId.data,
            sceneSourceAssetId: undefined,
            sceneBackgroundAssetId: undefined,
            recordingAssetIds: {},
          })
          state.room = nextRoom
          state.resultAssetId = assetId.data
          state.sceneSourceAssetId = undefined
          state.sceneBackgroundAssetId = undefined
          state.recordingAssetIds = {}
          try {
            await this.media(state).retainOnly([assetId.data])
          } catch (error) {
            console.error(
              'Failed to clean finalized room render inputs',
              error instanceof Error ? error.message : 'Unknown error',
            )
          }
          await this.scheduleAlarm()
          this.broadcast()
          return json({ result }, 201)
        }
        const resultRoute = /^\/results\/([^/]+)$/.exec(url.pathname)
        if (resultRoute) {
          const session = await this.authorizeSession(state, request)
          const resultId = resultIdSchema.safeParse(resultRoute[1])
          if (!resultId.success)
            throw new RoomError('INVALID_INPUT', 'The result identity is invalid.')
          if (!state.room.players.some((player) => player.id === session.playerId))
            throw new RoomError('UNAUTHORIZED', 'The player is no longer in this room.', 401)

          if (request.method === 'GET' || request.method === 'HEAD') {
            const result = state.room.result
            if (
              state.room.status !== 'finished' ||
              !result ||
              result.resultId !== resultId.data ||
              result.roomId !== state.room.id
            )
              throw new RoomError('RESULT_NOT_FOUND', 'The shared room result is unavailable.', 404)
            if (!state.resultAssetId)
              throw new RoomError('RESULT_NOT_FOUND', 'The shared room result is missing.', 404)
            const object = await this.media(state).read(
              state.resultAssetId,
              request.method,
              request.headers.get('Range'),
            )
            if (
              object.status === 404 ||
              Number(object.headers.get('X-Media-Total-Bytes')) !== result.byteSize
            )
              throw new RoomError('RESULT_NOT_FOUND', 'The shared room result is missing.', 404)
            return publicMediaResponse(
              object,
              'private, no-store',
              `inline; filename="${result.filename}"`,
            )
          }

          if (request.method === 'POST') {
            const metadata = resultUploadMetadataSchema.safeParse({
              resultId: request.headers.get('X-Result-Id'),
              manifestId: request.headers.get('X-Manifest-Id'),
            })
            if (!metadata.success || metadata.data.resultId !== resultId.data)
              throw new RoomError('INVALID_INPUT', 'The result metadata is invalid.')
            const committed = state.room.result
            if (state.room.status === 'finished' && committed) {
              if (
                committed.resultId === metadata.data.resultId &&
                committed.manifestId === metadata.data.manifestId
              )
                return json({ result: committed })
              throw new RoomError(
                'RESULT_ALREADY_COMMITTED',
                'This room already has a final result.',
                409,
              )
            }
            if (state.room.status !== 'processing')
              throw new RoomError(
                'ROOM_UNAVAILABLE',
                'A result can be uploaded only while the room is processing.',
                409,
              )
            const manifest = recordingManifestSchema.safeParse(state.room.recordingManifest)
            if (
              !manifest.success ||
              manifest.data.roomId !== state.room.id ||
              manifest.data.manifestId !== metadata.data.manifestId
            )
              throw new RoomError(
                'UNAUTHORIZED',
                'The frozen manifest does not match this room.',
                401,
              )
            if (request.headers.get('Content-Type') !== FINAL_RESULT_MIME_TYPE)
              throw new RoomError('UNSUPPORTED_MEDIA', 'Only MP4 final results are allowed.', 415)
            const byteSize = requireContentLength(request, MAX_FINAL_RESULT_BYTES)
            if (!request.body) throw new RoomError('INVALID_INPUT', 'A result body is required.')
            const pendingResult = {
              resultId: metadata.data.resultId,
              manifestId: manifest.data.manifestId,
              roomId: state.room.id,
              mimeType: FINAL_RESULT_MIME_TYPE,
              completedAt: Date.now(),
              filename: `take-two-${state.room.code}.mp4`,
            } as const
            let assetId: string | undefined
            let result: StoredRoomResult
            try {
              const asset = await this.media(state).put(
                request.body,
                'final-result',
                FINAL_RESULT_MIME_TYPE,
                byteSize,
              )
              assetId = asset.assetId
              result = { ...pendingResult, byteSize: asset.byteSize }
              const nextRoom = {
                ...state.room,
                status: 'finished' as const,
                result,
                expiresAt: Date.now() + this.ttl,
                revision: state.room.revision + 1,
              }
              await this.store.save({
                ...state,
                room: nextRoom,
                resultAssetId: asset.assetId,
                sceneSourceAssetId: undefined,
                sceneBackgroundAssetId: undefined,
                recordingAssetIds: {},
              })
              state.room = nextRoom
              state.resultAssetId = asset.assetId
              state.sceneSourceAssetId = undefined
              state.sceneBackgroundAssetId = undefined
              state.recordingAssetIds = {}
            } catch (error) {
              if (assetId)
                await this.media(state)
                  .delete(assetId)
                  .catch(() => undefined)
              if (error instanceof MediaStoreError) throw resultMediaError(error)
              console.error(
                'Final result upload failed',
                error instanceof Error ? error.message : 'Unknown error',
              )
              throw new RoomError('UPLOAD_FAILED', 'The final result could not be stored.', 503)
            }
            try {
              await this.media(state).retainOnly([assetId!])
            } catch (error) {
              console.error(
                'Failed to clean finalized room render inputs',
                error instanceof Error ? error.message : 'Unknown error',
              )
            }
            await this.scheduleAlarm()
            this.broadcast()
            return json({ result }, 201)
          }
          throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
        }
        const renderInputRoute = /^\/render-inputs\/([^/]+)$/.exec(url.pathname)
        if (renderInputRoute && ['GET', 'HEAD'].includes(request.method)) {
          const session = await this.authorizeSession(state, request)
          const recordingId = recordingIdSchema.safeParse(renderInputRoute[1])
          const manifestId = recordingManifestIdSchema.safeParse(
            request.headers.get('X-Manifest-Id'),
          )
          if (!recordingId.success || !manifestId.success)
            throw new RoomError('INVALID_INPUT', 'The renderer input identity is invalid.')
          if (state.room.status !== 'processing')
            throw new RoomError(
              'ROOM_UNAVAILABLE',
              'Renderer inputs are available only while the room is processing.',
              409,
            )
          const manifest = recordingManifestSchema.safeParse(state.room.recordingManifest)
          if (
            !manifest.success ||
            manifest.data.roomId !== state.room.id ||
            manifest.data.manifestId !== manifestId.data
          )
            throw new RoomError(
              'UNAUTHORIZED',
              'The frozen renderer manifest is unavailable for this room session.',
              401,
            )
          if (!state.room.players.some((player) => player.id === session.playerId))
            throw new RoomError('UNAUTHORIZED', 'The player is no longer in this room.', 401)
          const entry = manifest.data.entries.find(
            (candidate) => candidate.recordingId === recordingId.data,
          )
          if (!entry)
            throw new RoomError(
              'RECORDING_NOT_FOUND',
              'The requested recording does not belong to the frozen manifest.',
              404,
            )
          const assetId = state.recordingAssetIds?.[entry.recordingId]
          if (!assetId)
            throw new RoomError(
              'RECORDING_NOT_FOUND',
              'A recording referenced by the frozen manifest is missing.',
              404,
            )
          const object = await this.media(state).read(
            assetId,
            request.method as 'GET' | 'HEAD',
            request.headers.get('Range'),
          )
          if (
            object.status === 404 ||
            Number(object.headers.get('X-Media-Total-Bytes')) !== entry.byteSize
          )
            throw new RoomError(
              'RECORDING_NOT_FOUND',
              'A recording referenced by the frozen manifest is missing.',
              404,
            )
          return publicMediaResponse(object, 'private, no-store')
        }
        const recordingRoute = /^\/recordings\/([^/]+)$/.exec(url.pathname)
        if (recordingRoute && request.method === 'POST') {
          const session = await this.authorizeSession(state, request)
          const durationHeader = request.headers.get('X-Recording-Duration-Ms')
          const captureStartHeader = request.headers.get('X-Capture-Start-Ms')
          const captureEndHeader = request.headers.get('X-Capture-End-Ms')
          const metadata = recordingUploadMetadataSchema.safeParse({
            recordingId: request.headers.get('X-Recording-Id'),
            durationMs:
              durationHeader !== null && durationHeader.trim() !== ''
                ? Number(durationHeader)
                : Number.NaN,
            ...(captureStartHeader !== null ? { captureStartMs: Number(captureStartHeader) } : {}),
            ...(captureEndHeader !== null ? { captureEndMs: Number(captureEndHeader) } : {}),
          })
          if (!metadata.success)
            throw new RoomError('INVALID_INPUT', 'The recording metadata is invalid.')
          if (state.room.status === 'processing' || state.room.recordingManifest)
            throw new RoomError(
              'FINALIZATION_STARTED',
              'Final preparation has started; recordings are locked.',
              409,
            )
          if (state.room.status !== 'playing' || state.room.startedAt === null)
            throw new RoomError(
              'ROOM_UNAVAILABLE',
              'Recordings can be uploaded only after the game starts.',
              409,
            )
          const scene = resolveRoomScene(state.room)
          if (!scene) throw new RoomError('ROOM_UNAVAILABLE', 'The room scene is unavailable.', 409)
          const line = scene.lines.find((entry) => entry.id === recordingRoute[1])
          if (!line) throw new RoomError('INVALID_INPUT', 'The dialogue line does not exist.', 404)
          if (
            metadata.data.captureStartMs !== undefined &&
            metadata.data.captureEndMs !== undefined
          ) {
            const expectedCapture = getRecordingCaptureWindow(line, scene.durationMs)
            if (
              metadata.data.captureStartMs !== expectedCapture.captureStartMs ||
              metadata.data.captureEndMs !== expectedCapture.captureEndMs ||
              metadata.data.durationMs !==
                expectedCapture.captureEndMs - expectedCapture.captureStartMs
            )
              throw new RoomError(
                'INVALID_INPUT',
                'The recording capture timing does not match the canonical dialogue window.',
              )
          }
          const player = state.room.players.find((entry) => entry.id === session.playerId)
          if (!player)
            throw new RoomError('UNAUTHORIZED', 'The player is no longer in this room.', 401)
          if (!player.characterIds.includes(line.characterId))
            throw new RoomError(
              'LINE_NOT_OWNED',
              'The dialogue line is not assigned to this player.',
              403,
            )
          const mimeType = recordingMimeTypeSchema.safeParse(request.headers.get('Content-Type'))
          if (!mimeType.success)
            throw new RoomError(
              'UNSUPPORTED_MEDIA',
              'The recording media type is not allowed.',
              415,
            )
          const existing = state.room.recordings?.find((recording) => recording.lineId === line.id)
          if (existing?.recordingId === metadata.data.recordingId)
            return json({ recording: existing })

          const declaredHeader = request.headers.get('Content-Length')
          const declared = declaredHeader === null ? undefined : Number(declaredHeader)
          if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0))
            throw new RoomError('INVALID_INPUT', 'The recording length is invalid.')
          if (declared !== undefined && declared > MAX_RECORDING_BYTES)
            throw new RoomError('UPLOAD_TOO_LARGE', 'The recording exceeds the upload limit.', 413)
          if (!request.body) throw new RoomError('INVALID_INPUT', 'The recording body is empty.')
          let asset
          try {
            asset = await this.media(state).put(
              request.body,
              'line-recording',
              mimeType.data,
              declared,
            )
          } catch (error) {
            if (error instanceof MediaStoreError) throw recordingMediaError(error)
            throw error
          }

          const recording = {
            recordingId: metadata.data.recordingId,
            lineId: line.id,
            playerId: player.id,
            mimeType: mimeType.data,
            byteSize: asset.byteSize,
            durationMs: metadata.data.durationMs,
            ...(metadata.data.captureStartMs !== undefined &&
            metadata.data.captureEndMs !== undefined
              ? {
                  captureStartMs: metadata.data.captureStartMs,
                  captureEndMs: metadata.data.captureEndMs,
                }
              : {}),
            uploadedAt: Date.now(),
          }
          const nextRecordings = [
            ...(state.room.recordings ?? []).filter((entry) => entry.lineId !== line.id),
            recording,
          ]
          const nextRoomWithoutProgress = {
            ...state.room,
            recordings: nextRecordings,
            expiresAt: Date.now() + this.ttl,
            revision: state.room.revision + 1,
          }
          const nextRoom = {
            ...nextRoomWithoutProgress,
            recordingProgress: deriveRecordingProgress(nextRoomWithoutProgress, scene),
          }
          const previousAssetId = existing
            ? state.recordingAssetIds?.[existing.recordingId]
            : undefined
          const nextAssetIds = {
            ...(state.recordingAssetIds ?? {}),
            [recording.recordingId]: asset.assetId,
          }
          if (existing) delete nextAssetIds[existing.recordingId]
          try {
            await this.store.save({
              ...state,
              room: nextRoom,
              recordingAssetIds: nextAssetIds,
            })
            state.room = nextRoom
            state.recordingAssetIds = nextAssetIds
          } catch (error) {
            await this.media(state)
              .delete(asset.assetId)
              .catch(() => undefined)
            console.error(
              'Recording upload failed',
              error instanceof Error ? error.message : 'Unknown error',
            )
            throw new RoomError('UPLOAD_FAILED', 'The recording could not be stored.', 503)
          }
          if (previousAssetId)
            await this.media(state)
              .delete(previousAssetId)
              .catch(() => undefined)
          await this.scheduleAlarm()
          this.broadcast()
          return json({ recording }, 201)
        }
        if (url.pathname === '/summary' && request.method === 'GET') {
          const { id, code, sceneId, status, expiresAt, players } = state.room
          return json({ id, code, sceneId, status, expiresAt, playerCount: players.length })
        }
        if (url.pathname === '/join' && request.method === 'POST') {
          const input = joinRoomRequestSchema.safeParse(await readJson(request))
          if (!input.success)
            throw new RoomError(
              'INVALID_INPUT',
              input.error.issues[0]?.message ?? 'Invalid nickname.',
            )
          state.joinRequests ??= {}
          const previous = state.joinRequests[input.data.requestId]
          if (previous) {
            const validRetry =
              previous.nickname === input.data.nickname &&
              state.tokenHashes[previous.playerId] === (await hashToken(input.data.requestToken)) &&
              state.room.players.some((player) => player.id === previous.playerId)
            if (!validRetry)
              throw new RoomError(
                'UNAUTHORIZED',
                'This join request cannot be reused with different credentials.',
                401,
              )
            return json(this.session(previous.playerId, input.data.requestToken), 201)
          }
          const player = newPlayer(crypto.randomUUID(), input.data.nickname)
          addPlayer(state.room, player)
          state.tokenHashes[player.id] = await hashToken(input.data.requestToken)
          state.joinRequests[input.data.requestId] = {
            playerId: player.id,
            nickname: player.nickname,
          }
          await this.persist(true)
          this.broadcast()
          return json(this.session(player.id, input.data.requestToken), 201)
        }
        if (url.pathname === '/socket' && request.method === 'GET') {
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
            throw new RoomError('INVALID_INPUT', 'A WebSocket connection is required.', 426)
          if (this.sockets().length >= MAX_PLAYERS * 2)
            throw new RoomError(
              'RATE_LIMITED',
              'Too many room connections. Try again shortly.',
              429,
            )
          const pair = new WebSocketPair()
          this.ctx.acceptWebSocket(pair[1])
          pair[1].serializeAttachment({
            playerId: null,
            roomId: state.room.id,
            authDeadline: Date.now() + 10_000,
            windowStart: Date.now(),
            messageCount: 0,
          } satisfies Connection)
          await this.scheduleAlarm()
          return new Response(null, { status: 101, webSocket: pair[0] })
        }
        throw new RoomError('INVALID_INPUT', 'Unknown room operation.', 404)
      } catch (error) {
        return errorResponse(error)
      }
    })
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const state = await this.requireRoom()
        const connection = this.connection(socket)
        if (!connection)
          throw new RoomError('UNAUTHORIZED', 'Reconnect to authenticate your session.', 401)
        if (connection.roomId !== state.room.id)
          throw new RoomError('UNAUTHORIZED', 'This room session has expired.', 401)
        if (
          typeof raw !== 'string' ||
          new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES
        ) {
          throw new RoomError('INVALID_MESSAGE', 'Messages must be small JSON text messages.')
        }
        if (Date.now() - connection.windowStart > 10_000) {
          connection.windowStart = Date.now()
          connection.messageCount = 0
        }
        connection.messageCount++
        socket.serializeAttachment(connection)
        if (connection.messageCount > 30)
          throw new RoomError('RATE_LIMITED', 'Too many messages. Reconnect shortly.', 429)
        let value: unknown
        try {
          value = JSON.parse(raw) as unknown
        } catch {
          throw new RoomError('INVALID_MESSAGE', 'The message contains invalid JSON.')
        }
        const message = clientMessageSchema.safeParse(value)
        if (!message.success)
          throw new RoomError('INVALID_MESSAGE', 'This room does not support that message.')
        if (message.data.type === 'AUTH') {
          if (connection.playerId || connection.authDeadline < Date.now())
            throw new RoomError('UNAUTHORIZED', 'Reconnect to authenticate your session.', 401)
          const session = message.data.session
          if (
            session.roomId !== state.room.id ||
            session.code !== state.room.code ||
            state.tokenHashes[session.playerId] !== (await hashToken(session.token))
          ) {
            throw new RoomError(
              'UNAUTHORIZED',
              'Your room session is no longer valid. Join again.',
              401,
            )
          }
          // Only the newest connection controls a session. Its predecessor must not
          // mark the replacement offline when its delayed close event arrives.
          for (const previous of this.sockets()) {
            if (previous === socket) continue
            const attachment = this.connection(previous)
            if (attachment?.playerId === session.playerId) {
              previous.serializeAttachment({ ...attachment, playerId: null })
              this.send(previous, {
                type: 'ERROR',
                payload: {
                  code: 'SESSION_REPLACED',
                  message:
                    'This player connected in another tab. Use that tab or join with a new nickname.',
                },
              })
              previous.close(4409, 'Session replaced')
            }
          }
          connection.playerId = session.playerId
          socket.serializeAttachment(connection)
          updatePresence(state.room, session.playerId, true)
          await this.persist(true)
          this.broadcast()
          return
        }
        if (!connection.playerId)
          throw new RoomError('UNAUTHORIZED', 'Authenticate before sending room commands.', 401)
        switch (message.data.type) {
          case 'PLAYER_READY':
            setReady(state.room, connection.playerId, message.data.ready)
            await this.persist(true)
            this.broadcast()
            break
          case 'START_GAME': {
            const scene = resolveRoomScene(state.room)
            if (!scene)
              throw new RoomError(
                'ROOM_UNAVAILABLE',
                'The selected scene is no longer available.',
                409,
              )
            startGame(
              state.room,
              connection.playerId,
              scene.characters.map((character) => character.id),
              Date.now(),
            )
            state.room.recordingProgress = deriveRecordingProgress(state.room, scene)
            state.room.recordingManifest = null
            await this.persist(true)
            this.broadcast()
            break
          }
          case 'FINALIZE_RECORDINGS': {
            const scene = resolveRoomScene(state.room)
            if (!scene)
              throw new RoomError(
                'ROOM_UNAVAILABLE',
                'The selected scene is no longer available.',
                409,
              )
            finalizeRecordings(
              state.room,
              connection.playerId,
              scene,
              crypto.randomUUID(),
              Date.now(),
            )
            await this.persist(true)
            this.broadcast()
            break
          }
          case 'LEAVE_ROOM': {
            removePlayer(state.room, connection.playerId)
            delete state.tokenHashes[connection.playerId]
            for (const [requestId, request] of Object.entries(state.joinRequests ?? {})) {
              if (request.playerId === connection.playerId) delete state.joinRequests![requestId]
            }
            socket.serializeAttachment({ ...connection, playerId: null })
            this.send(socket, { type: 'LEFT_ROOM' })
            socket.close(1000, 'Left room')
            if (!state.room.players.length) await this.expire()
            else {
              const scene = resolveRoomScene(state.room)
              if (scene && state.room.status === 'playing')
                state.room.recordingProgress = deriveRecordingProgress(state.room, scene)
              await this.persist(true)
              this.broadcast()
            }
            break
          }
          case 'PING':
            this.send(socket, { type: 'PONG' })
            break
        }
      } catch (error) {
        const failure =
          error instanceof RoomError
            ? error
            : new RoomError(
                'SERVER_ERROR',
                'The room service had a problem. Please reconnect.',
                500,
              )
        if (!(error instanceof RoomError))
          console.error(
            'Room message failed',
            error instanceof Error ? error.message : 'Unknown error',
          )
        this.send(socket, {
          type: 'ERROR',
          payload: { code: failure.code, message: failure.message },
        })
        if (
          failure.code !== 'INVALID_MESSAGE' &&
          failure.code !== 'ROOM_UNAVAILABLE' &&
          failure.code !== 'FORBIDDEN' &&
          failure.code !== 'RECORDINGS_INCOMPLETE' &&
          failure.code !== 'FINALIZATION_STARTED'
        ) {
          socket.close(
            failure.code === 'ROOM_NOT_FOUND'
              ? 4404
              : failure.code === 'UNAUTHORIZED'
                ? 4401
                : 1013,
            'Room command rejected',
          )
        }
      }
    })
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.disconnect(socket)
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, 'Connection error')
    await this.disconnect(socket)
  }

  private async disconnect(socket: WebSocket): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const connection = this.connection(socket)
      if (
        !this.state ||
        !connection ||
        this.state.room.id !== connection.roomId ||
        !connection.playerId
      )
        return
      socket.serializeAttachment({ ...connection, playerId: null })
      if (!this.state.room.players.some((player) => player.id === connection.playerId)) return
      updatePresence(this.state.room, connection.playerId, false)
      await this.persist(false)
      this.broadcast()
    })
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.state || this.state.room.expiresAt <= Date.now()) {
        await this.expire()
        return
      }
      for (const socket of this.sockets()) {
        const connection = this.connection(socket)
        if (!connection || (!connection.playerId && connection.authDeadline <= Date.now()))
          socket.close(4401, 'Authentication timeout')
      }
      await this.scheduleAlarm()
    })
  }

  private async requireRoom(): Promise<StoredRoom> {
    if (this.state && this.state.room.expiresAt <= Date.now()) await this.expire()
    if (!this.state)
      throw new RoomError(
        'ROOM_NOT_FOUND',
        'Room not found or expired. Check the code or create a new room.',
        404,
      )
    return this.state
  }
  private session(playerId: string, token: string): RoomSession {
    return { code: this.state!.room.code, roomId: this.state!.room.id, playerId, token }
  }
  private async authorizeSession(state: StoredRoom, request: Request): Promise<RoomSession> {
    const authorization = request.headers.get('Authorization')
    const session = sessionSchema.safeParse({
      code: state.room.code,
      roomId: request.headers.get('X-Room-Id'),
      playerId: request.headers.get('X-Player-Id'),
      token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : null,
    })
    if (
      !session.success ||
      session.data.roomId !== state.room.id ||
      state.tokenHashes[session.data.playerId] !== (await hashToken(session.data.token))
    )
      throw new RoomError('UNAUTHORIZED', 'The anonymous room session is invalid or expired.', 401)
    return session.data
  }
  private media(state: StoredRoom) {
    return new MediaStoreClient(this.env.MEDIA_STORE, `room:${state.room.id}`)
  }
  private connection(socket: WebSocket): Connection | null {
    const value: unknown = socket.deserializeAttachment()
    if (!value || typeof value !== 'object') return null
    const entry = value as Partial<Connection>
    if (
      (entry.playerId !== null && typeof entry.playerId !== 'string') ||
      typeof entry.roomId !== 'string' ||
      !Number.isFinite(entry.authDeadline) ||
      !Number.isFinite(entry.windowStart) ||
      !Number.isSafeInteger(entry.messageCount)
    )
      return null
    return entry as Connection
  }
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN)
  }
  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      socket.close(1011, 'Delivery failed')
    }
  }
  private broadcast(): void {
    if (!this.state) return
    for (const socket of this.sockets()) {
      const connection = this.connection(socket)
      if (connection?.playerId && connection.roomId === this.state.room.id)
        this.send(socket, { type: 'ROOM_STATE', payload: this.state.room })
    }
  }
  private async persist(activity: boolean): Promise<void> {
    if (!this.state) return
    if (activity) this.state.room.expiresAt = Date.now() + this.ttl
    this.state.room.revision++
    await this.store.save(this.state)
    await this.scheduleAlarm()
  }
  private async scheduleAlarm(): Promise<void> {
    if (!this.state) return
    const authDeadlines = this.sockets()
      .map((socket) => this.connection(socket))
      .filter((entry): entry is Connection => Boolean(entry && !entry.playerId))
      .map((entry) => entry.authDeadline)
    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 100, Math.min(this.state.room.expiresAt, ...authDeadlines)),
    )
  }
  private async expire(): Promise<void> {
    const roomId = this.state?.room.id
    const media = this.state ? this.media(this.state) : null
    for (const socket of this.sockets()) {
      this.send(socket, {
        type: 'ERROR',
        payload: {
          code: 'ROOM_NOT_FOUND',
          message: 'This room has expired. Create a new room to continue.',
        },
      })
      socket.close(4404, 'Room expired')
    }
    this.state = null
    await this.store.clear()
    if (roomId && media)
      try {
        await media.cleanup()
      } catch (error) {
        console.error(
          'Failed to delete expired room recordings',
          error instanceof Error ? error.message : 'Unknown error',
        )
      }
  }
}

function recordingMediaError(error: MediaStoreError) {
  if (error.reason === 'too-large')
    return new RoomError('UPLOAD_TOO_LARGE', 'The recording exceeds the upload limit.', 413)
  if (error.reason === 'unsupported-media')
    return new RoomError(
      'UNSUPPORTED_MEDIA',
      'The recording bytes do not match the declared media type.',
      415,
    )
  if (error.reason === 'empty')
    return new RoomError('INVALID_INPUT', 'The recording body is empty.')
  if (error.reason === 'length-mismatch')
    return new RoomError('INVALID_INPUT', 'The recording length did not match the upload.')
  return new RoomError('UPLOAD_FAILED', 'The recording could not be stored.', 503)
}

function resultMediaError(error: MediaStoreError) {
  if (error.reason === 'too-large')
    return new RoomError('UPLOAD_TOO_LARGE', 'The final result exceeds the upload limit.', 413)
  if (error.reason === 'unsupported-media')
    return new RoomError(
      'UNSUPPORTED_MEDIA',
      'The final result does not contain a valid MP4 signature.',
      415,
    )
  if (error.reason === 'length-mismatch')
    return new RoomError('INVALID_INPUT', 'Content-Length did not match the upload.')
  return new RoomError('UPLOAD_FAILED', 'The final result could not be stored.', 503)
}

function stripLegacyObjectKeys(room: StoredRoom['room']): StoredRoom['room'] {
  const strip = <T>(value: T): T => {
    if (!value || typeof value !== 'object') return value
    const rest = { ...(value as Record<string, unknown>) }
    delete rest.objectKey
    return rest as T
  }
  return {
    ...room,
    recordings: room.recordings?.map(strip),
    recordingManifest: room.recordingManifest
      ? {
          ...room.recordingManifest,
          entries: room.recordingManifest.entries.map(strip),
        }
      : room.recordingManifest,
    result: room.result ? strip(room.result) : room.result,
  }
}
