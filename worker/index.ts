import { createRoomSchema, joinRoomRequestSchema, roomCodeSchema } from '../shared/schemas/room'
import { recordingIdSchema, recordingLineIdSchema } from '../shared/schemas/recording'
import {
  FINAL_RESULT_MIME_TYPE,
  MAX_FINAL_RESULT_BYTES,
  resultIdSchema,
  storedRoomResultSchema,
} from '../shared/schemas/result'
import { preparationDraftResponseSchema } from '../shared/schemas/studio'
import { getSceneById } from '../shared/scenes/catalog'
import {
  ffmpegRuntimeManifest,
  isFfmpegRuntimeNamespace,
  isFfmpegRuntimePath,
} from '../shared/runtime/ffmpegRuntime'
import { reserveRoomCode } from './domain/codes'
import { RoomError } from './domain/errors'
import { errorResponse, json, readJson, requireContentLength } from './lib/http'
import { allowRequest } from './lib/rateLimit'
import { copyMediaAsset, MediaStoreClient, MediaStoreError } from './storage/mediaStore'
import type { Env } from './types/env'

export { GameRoom } from './durable-objects/GameRoom'
export { SceneStudio } from './durable-objects/SceneStudio'
export { MediaStore } from './storage/mediaStore'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url)
    const origin = request.headers.get('Origin')
    const allowed =
      origin === requestUrl.origin ||
      env.ALLOWED_ORIGINS.split(',')
        .map((value) => value.trim())
        .includes(origin ?? '')
    if (origin && !allowed)
      return errorResponse(
        new RoomError('ORIGIN_DENIED', 'This site is not allowed to access the room service.', 403),
      )
    let response: Response
    try {
      if (request.method === 'OPTIONS') {
        if (!allowed) throw new RoomError('ORIGIN_DENIED', 'An allowed origin is required.', 403)
        response = new Response(null, { status: 204 })
      } else {
        const url = requestUrl
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
        if (!allowRequest(`requests:${ip}`, 180))
          throw new RoomError(
            'RATE_LIMITED',
            'Too many requests. Wait a minute and try again.',
            429,
          )
        if (!url.pathname.startsWith('/api/')) {
          if (isFfmpegRuntimeNamespace(url.pathname)) {
            if (!isFfmpegRuntimePath(url.pathname))
              throw new RoomError('INVALID_INPUT', 'Runtime asset not found.', 404)
            if (!['GET', 'HEAD'].includes(request.method))
              throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
          }
          response = await env.ASSETS.fetch(request)
        } else if (url.pathname === '/api/health' && request.method === 'GET')
          response = json({ ok: true })
        else if (url.pathname.startsWith('/api/private-scenes')) {
          const studioPath = studioRoute(url.pathname)
          if (!studioPath)
            throw new RoomError('INVALID_INPUT', 'Scene Studio route not found.', 404)
          if (request.method === 'POST' && studioPath === '/upload') {
            if (!allowRequest(`scene-uploads:${ip}`, 12))
              throw new RoomError('RATE_LIMITED', 'Too many scene uploads. Try again shortly.', 429)
            response = await sceneStudio(env).fetch(
              new Request(`https://studio${studioPath}`, {
                method: request.method,
                headers: request.headers,
                body: request.body,
              }),
            )
          } else if (request.method === 'POST' && studioPath.startsWith('/background/')) {
            if (!allowRequest(`background-uploads:${ip}`, 12))
              throw new RoomError(
                'RATE_LIMITED',
                'Too many background uploads. Try again shortly.',
                429,
              )
            response = await sceneStudio(env).fetch(
              new Request(`https://studio${studioPath}`, {
                method: request.method,
                headers: request.headers,
                body: request.body,
              }),
            )
          } else if (request.method === 'POST' && studioPath.startsWith('/thumbnail/')) {
            if (!allowRequest(`thumbnail-uploads:${ip}`, 20))
              throw new RoomError(
                'RATE_LIMITED',
                'Too many thumbnail uploads. Try again shortly.',
                429,
              )
            response = await sceneStudio(env).fetch(
              new Request(`https://studio${studioPath}`, {
                method: request.method,
                headers: request.headers,
                body: request.body,
              }),
            )
          } else {
            let body: string | undefined
            if (request.method === 'PUT') body = JSON.stringify(await readJson(request))
            response = await sceneStudio(env).fetch(
              new Request(`https://studio${studioPath}`, {
                method: request.method,
                headers: request.headers,
                body,
              }),
            )
          }
        } else if (url.pathname === '/api/rooms' && request.method === 'POST') {
          if (!allowRequest(`create:${ip}`, 10))
            throw new RoomError(
              'RATE_LIMITED',
              'Too many rooms created. Wait a minute and try again.',
              429,
            )
          const parsed = createRoomSchema.safeParse(await readJson(request))
          if (!parsed.success)
            throw new RoomError(
              'INVALID_INPUT',
              parsed.error.issues[0]?.message ?? 'Invalid room details.',
            )
          const builtInScene = getSceneById(parsed.data.sceneId)
          let privateScene: Awaited<ReturnType<typeof resolvePrivateScene>> | null = null
          if (!builtInScene)
            privateScene = await resolvePrivateScene(env, parsed.data.sceneId, request.headers)
          if (!builtInScene && !privateScene)
            throw new RoomError('INVALID_INPUT', 'Choose a scene from the library.')
          response = await reserveRoomCode(async (code) => {
            const roomId = crypto.randomUUID()
            let sceneSourceAssetId: string | undefined
            let sceneBackgroundAssetId: string | undefined
            const selectedScene = builtInScene ?? privateScene!.draft.scene!
            let sceneSnapshot = selectedScene
            if (privateScene) {
              const source = await copyMediaAsset(
                env.MEDIA_STORE,
                `scene:${selectedScene.id}`,
                privateScene.sourceAssetId,
                `room:${roomId}`,
                'room-source',
              )
              sceneSourceAssetId = source.assetId
              if (source.byteSize !== privateScene.draft.media.byteSize) {
                await new MediaStoreClient(env.MEDIA_STORE, `room:${roomId}`).cleanup()
                throw new RoomError(
                  'RECORDING_NOT_FOUND',
                  'Private scene media is incomplete.',
                  404,
                )
              }
              if (privateScene.backgroundAssetId && privateScene.draft.backgroundAudio) {
                const background = await copyMediaAsset(
                  env.MEDIA_STORE,
                  `scene:${selectedScene.id}`,
                  privateScene.backgroundAssetId,
                  `room:${roomId}`,
                  'room-background',
                )
                if (background.byteSize !== privateScene.draft.backgroundAudio.byteSize) {
                  await new MediaStoreClient(env.MEDIA_STORE, `room:${roomId}`).cleanup()
                  throw new RoomError(
                    'RECORDING_NOT_FOUND',
                    'Prepared background audio is incomplete.',
                    404,
                  )
                }
                sceneBackgroundAssetId = background.assetId
              }
              sceneSnapshot = {
                ...selectedScene,
                videoUrl: `/api/rooms/${code}/source-video`,
                thumbnailUrl: undefined,
                ...(sceneBackgroundAssetId
                  ? { backgroundAudioUrl: `/api/rooms/${code}/render-background` }
                  : { backgroundAudioUrl: undefined }),
              }
            }
            try {
              const result = await env.ROOMS.getByName(code).fetch(
                new Request(`https://room/create?code=${code}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ...parsed.data,
                    roomId,
                    sceneSnapshot,
                    sceneSourceAssetId,
                    sceneBackgroundAssetId,
                  }),
                }),
              )
              if (result.status === 409) {
                if (sceneSourceAssetId)
                  await new MediaStoreClient(env.MEDIA_STORE, `room:${roomId}`).cleanup()
                return null
              }
              return result
            } catch (error) {
              if (sceneSourceAssetId)
                await new MediaStoreClient(env.MEDIA_STORE, `room:${roomId}`).cleanup()
              throw error
            }
          })
        } else {
          const sourceRoute = /^\/api\/rooms\/([^/]+)\/source-video$/.exec(url.pathname)
          if (sourceRoute) {
            if (!['GET', 'HEAD'].includes(request.method))
              throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
            const code = roomCodeSchema.safeParse(sourceRoute[1])
            if (!code.success) throw new RoomError('INVALID_INPUT', 'The source route is invalid.')
            response = await env.ROOMS.getByName(code.data).fetch(
              new Request('https://room/source-video', {
                method: request.method,
                headers: request.headers,
              }),
            )
          } else {
            const backgroundRoute = /^\/api\/rooms\/([^/]+)\/render-background$/.exec(url.pathname)
            if (backgroundRoute) {
              if (!['GET', 'HEAD'].includes(request.method))
                throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
              if (!allowRequest(`render-background:${ip}`, 30))
                throw new RoomError('RATE_LIMITED', 'Too many renderer requests.', 429)
              const code = roomCodeSchema.safeParse(backgroundRoute[1])
              if (!code.success)
                throw new RoomError('INVALID_INPUT', 'The background route is invalid.')
              response = await env.ROOMS.getByName(code.data).fetch(
                new Request('https://room/render-background', {
                  method: request.method,
                  headers: request.headers,
                }),
              )
            } else {
              const resultRoute = /^\/api\/rooms\/([^/]+)\/results\/([^/]+)$/.exec(url.pathname)
              if (resultRoute) {
                if (!['GET', 'HEAD', 'POST'].includes(request.method))
                  throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
                const code = roomCodeSchema.safeParse(resultRoute[1])
                const resultId = resultIdSchema.safeParse(resultRoute[2])
                if (!code.success || !resultId.success)
                  throw new RoomError('INVALID_INPUT', 'The result route is invalid.')
                if (request.method === 'POST') {
                  if (!allowRequest(`result-uploads:${ip}`, 12))
                    throw new RoomError(
                      'RATE_LIMITED',
                      'Too many result uploads. Try again shortly.',
                      429,
                    )
                  if (request.headers.get('Content-Type') !== FINAL_RESULT_MIME_TYPE)
                    throw new RoomError(
                      'UNSUPPORTED_MEDIA',
                      'Only MP4 final results are allowed.',
                      415,
                    )
                  const room = env.ROOMS.getByName(code.data)
                  const authorization = await room.fetch(
                    new Request(`https://room/results/${resultId.data}/authorize-upload`, {
                      method: 'POST',
                      headers: request.headers,
                    }),
                  )
                  if (!authorization.ok) response = authorization
                  else {
                    const decision = (await authorization.json()) as {
                      status?: unknown
                      result?: unknown
                      pending?: unknown
                    }
                    if (decision.status === 'committed')
                      response = json({ result: decision.result })
                    else {
                      const pending = storedRoomResultSchema
                        .omit({ byteSize: true })
                        .safeParse(decision.pending)
                      if (!pending.success)
                        throw new RoomError(
                          'SERVER_ERROR',
                          'Invalid internal upload authorization.',
                          500,
                        )
                      const byteSize = requireContentLength(request, MAX_FINAL_RESULT_BYTES)
                      if (!request.body)
                        throw new RoomError('INVALID_INPUT', 'A result body is required.')
                      const media = new MediaStoreClient(
                        env.MEDIA_STORE,
                        `room:${pending.data.roomId}`,
                      )
                      let assetId: string | undefined
                      try {
                        const asset = await media.put(
                          request.body,
                          'final-result',
                          pending.data.mimeType,
                          byteSize,
                        )
                        assetId = asset.assetId
                        const result = { ...pending.data, byteSize: asset.byteSize }
                        const commitHeaders = new Headers(request.headers)
                        commitHeaders.set('Content-Type', 'application/json')
                        commitHeaders.set('X-Media-Asset-Id', asset.assetId)
                        const commit = await room.fetch(
                          new Request(`https://room/results/${resultId.data}/commit-upload`, {
                            method: 'POST',
                            headers: commitHeaders,
                            body: JSON.stringify(result),
                          }),
                        )
                        if (!commit.ok) {
                          await media.delete(asset.assetId)
                          assetId = undefined
                        }
                        response = commit
                      } catch (error) {
                        if (assetId) await media.delete(assetId).catch(() => undefined)
                        if (error instanceof MediaStoreError) {
                          if (error.reason === 'too-large')
                            throw new RoomError(
                              'UPLOAD_TOO_LARGE',
                              'The final result exceeds the upload limit.',
                              413,
                            )
                          if (error.reason === 'unsupported-media')
                            throw new RoomError(
                              'UNSUPPORTED_MEDIA',
                              'The final result does not contain a valid MP4 signature.',
                              415,
                            )
                          if (error.reason === 'length-mismatch')
                            throw new RoomError(
                              'INVALID_INPUT',
                              'Content-Length did not match the upload.',
                            )
                        }
                        throw error
                      }
                    }
                  }
                } else {
                  if (!allowRequest(`results:${ip}`, 120))
                    throw new RoomError(
                      'RATE_LIMITED',
                      'Too many result requests. Try again shortly.',
                      429,
                    )
                  response = await env.ROOMS.getByName(code.data).fetch(
                    new Request(`https://room/results/${resultId.data}`, {
                      method: request.method,
                      headers: request.headers,
                    }),
                  )
                }
              } else {
                const renderInputRoute = /^\/api\/rooms\/([^/]+)\/render-inputs\/([^/]+)$/.exec(
                  url.pathname,
                )
                if (renderInputRoute) {
                  if (!['GET', 'HEAD'].includes(request.method))
                    throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
                  if (!allowRequest(`render-inputs:${ip}`, 120))
                    throw new RoomError(
                      'RATE_LIMITED',
                      'Too many renderer input requests. Wait a minute and try again.',
                      429,
                    )
                  const code = roomCodeSchema.safeParse(renderInputRoute[1])
                  const recordingId = recordingIdSchema.safeParse(renderInputRoute[2])
                  if (!code.success || !recordingId.success)
                    throw new RoomError('INVALID_INPUT', 'The renderer input route is invalid.')
                  response = await env.ROOMS.getByName(code.data).fetch(
                    new Request(`https://room/render-inputs/${recordingId.data}`, {
                      method: request.method,
                      headers: request.headers,
                    }),
                  )
                } else {
                  const uploadRoute = /^\/api\/rooms\/([^/]+)\/recordings\/([^/]+)$/.exec(
                    url.pathname,
                  )
                  if (uploadRoute) {
                    if (request.method !== 'POST')
                      throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
                    if (!allowRequest(`uploads:${ip}`, 60))
                      throw new RoomError(
                        'RATE_LIMITED',
                        'Too many recording uploads. Wait a minute and try again.',
                        429,
                      )
                    const code = roomCodeSchema.safeParse(uploadRoute[1])
                    let decodedLineId = ''
                    try {
                      decodedLineId = decodeURIComponent(uploadRoute[2]!)
                    } catch {
                      throw new RoomError('INVALID_INPUT', 'The line identifier is invalid.')
                    }
                    const lineId = recordingLineIdSchema.safeParse(decodedLineId)
                    if (!code.success || !lineId.success)
                      throw new RoomError('INVALID_INPUT', 'The recording route is invalid.')
                    response = await env.ROOMS.getByName(code.data).fetch(
                      new Request(`https://room/recordings/${lineId.data}`, {
                        method: 'POST',
                        headers: request.headers,
                        body: request.body,
                      }),
                    )
                  } else {
                    const route = /^\/api\/rooms\/([^/]+)(?:\/(join|socket))?$/.exec(url.pathname)
                    if (!route) throw new RoomError('INVALID_INPUT', 'API route not found.', 404)
                    const code = roomCodeSchema.safeParse(route[1])
                    if (!code.success)
                      throw new RoomError('INVALID_INPUT', 'Enter exactly 6 digits.')
                    const action = route[2] ?? 'summary'
                    if (request.method !== (action === 'join' ? 'POST' : 'GET'))
                      throw new RoomError('INVALID_INPUT', 'Method not allowed.', 405)
                    if (action === 'socket' && !allowed)
                      throw new RoomError(
                        'ORIGIN_DENIED',
                        'An allowed browser origin is required.',
                        403,
                      )
                    let forwarded: Request
                    if (action === 'join') {
                      // Finish reading the inbound stream before a DO can short-circuit
                      // with 404/409. Forwarding that live stream can outlive its request.
                      const input = joinRoomRequestSchema.safeParse(await readJson(request))
                      if (!input.success)
                        throw new RoomError(
                          'INVALID_INPUT',
                          input.error.issues[0]?.message ?? 'Invalid nickname.',
                        )
                      forwarded = new Request('https://room/join', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(input.data),
                      })
                    } else forwarded = new Request(`https://room/${action}`, request)
                    response = await env.ROOMS.getByName(code.data).fetch(forwarded)
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      response = errorResponse(error)
    }
    if (response.status === 101) return response
    const staticRuntimeResponse = isFfmpegRuntimePath(requestUrl.pathname)
    const headers = new Headers(response.headers)
    if (staticRuntimeResponse && response.ok) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable, no-transform')
      headers.set('Cross-Origin-Resource-Policy', 'same-origin')
      if (requestUrl.pathname.endsWith(ffmpegRuntimeManifest.javascript.fileName))
        headers.set('Content-Type', 'text/javascript; charset=utf-8')
      else if (requestUrl.pathname.endsWith('/manifest.json'))
        headers.set('Content-Type', 'application/json; charset=utf-8')
      else headers.set('Content-Type', 'application/octet-stream')
    }
    if (allowed && origin) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Vary', 'Origin')
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Room-Id, X-Player-Id, X-Recording-Id, X-Recording-Duration-Ms, X-Capture-Start-Ms, X-Capture-End-Ms, X-Manifest-Id, X-Result-Id, X-Scene-Authorization, X-Scene-Filename, X-Scene-Duration-Ms, X-Scene-Width, X-Scene-Height, X-Background-Duration-Ms, X-Background-Sample-Rate, X-Background-Channels, X-Background-Provider, X-Background-Provider-Version, X-Background-Model, X-Background-Device, X-Thumbnail-Width, X-Thumbnail-Height, X-Thumbnail-Captured-At-Ms',
      )
    }
    applySecurityHeaders(headers)
    return new Response(response.body, { status: response.status, headers })
  },
} satisfies ExportedHandler<Env>

function applySecurityHeaders(headers: Headers) {
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Frame-Options', 'DENY')
  headers.set(
    'Permissions-Policy',
    'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
  )
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob: ws: wss: http://127.0.0.1:8765 http://localhost:8765",
  )
}

function sceneStudio(env: Env) {
  return env.SCENE_STUDIO.getByName('private-scene-studio')
}

function studioRoute(pathname: string) {
  if (pathname === '/api/private-scenes') return '/list'
  if (pathname === '/api/private-scenes/upload') return '/upload'
  const match =
    /^\/api\/private-scenes\/(private-[a-f0-9]{12})(?:\/(source|background|thumbnail))?$/.exec(
      pathname,
    )
  if (!match) return null
  return `/${match[2] ?? 'scene'}/${match[1]}`
}

async function resolvePrivateScene(env: Env, sceneId: string, headers: Headers) {
  if (!/^private-[a-f0-9]{12}$/.test(sceneId)) return null
  const response = await sceneStudio(env).fetch(
    new Request(`https://studio/internal/${sceneId}`, {
      headers: { Authorization: headers.get('X-Scene-Authorization') ?? '' },
    }),
  )
  if (!response.ok) return null
  const data = (await response.json()) as {
    draft?: unknown
    sourceAssetId?: unknown
    backgroundAssetId?: unknown
  }
  const draft = preparationDraftResponseSchema.shape.draft.safeParse(data.draft)
  if (
    !draft.success ||
    draft.data.status !== 'prepared' ||
    !draft.data.scene ||
    typeof data.sourceAssetId !== 'string'
  )
    return null
  return {
    draft: draft.data,
    sourceAssetId: data.sourceAssetId,
    backgroundAssetId:
      typeof data.backgroundAssetId === 'string' ? data.backgroundAssetId : undefined,
  }
}
