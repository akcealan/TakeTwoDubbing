/// <reference types="@cloudflare/workers-types" />

export interface Env {
  ROOMS: DurableObjectNamespace
  SCENE_STUDIO: DurableObjectNamespace
  MEDIA_STORE: DurableObjectNamespace
  ASSETS: Fetcher
  ALLOWED_ORIGINS: string
  ROOM_TTL_MS: string
}
