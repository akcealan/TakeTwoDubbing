# Production Hardening / Readiness

Date: 2026-09-12. This is a historical pre-migration report. Its application-media details are
superseded by `R2_FREE_MEDIA_STORAGE.md`, and its runtime R2 details are superseded by
`R2_FREE_FFMPEG_RUNTIME.md`. The current architecture has zero R2 bindings. No Cloudflare resource has
been created and no deployment has been run.

> Historical note (post-2026-09-13): the deployment described as "not run" above
> was later completed — Worker `take-two-rooms` at
> `https://take-two-rooms.take-two.workers.dev`. See `docs/ARCHIVAL.md` and
> `docs/SHUTDOWN_CHECKLIST.md` for the inactive status and shutdown plan.

## Deployment topology

One Worker origin (`https://take-two-rooms.<account>.workers.dev`) owns the whole product:

- Workers Static Assets serves `dist/`; `single-page-application` provides deep-link fallback.
- `run_worker_first: true` sends every request through the Worker security-header boundary.
- `/api/*` routes HTTP and WebSocket requests to `ROOMS`, `SCENE_STUDIO` and SQLite-backed
  `MEDIA_STORE` Durable Objects.
- Versioned `/runtime/ffmpeg/0.12.10/*` files are normal Workers Static Assets; the WASM is two
  deterministic sub-25-MiB parts reconstructed and verified in the browser.
- The browser uses same-origin API, WebSocket, private media and runtime URLs. No custom domain,
  public media bucket, third-party CDN or paid service is required.

`wrangler.jsonc` is the production configuration. `wrangler.dev.jsonc` preserves local Vite +
Wrangler development without requiring a prebuilt `dist/` directory.

## Official Cloudflare Free constraints used

Values were checked against official documentation on 2026-09-12; they are service limits,
not lifetime promises.

| Constraint                 |                                                 Current official Free value | Design consequence                                                         |
| -------------------------- | --------------------------------------------------------------------------: | -------------------------------------------------------------------------- |
| Worker requests            |                                                                 100,000/day | Small private-group product; exhaustion fails rather than bills silently.  |
| Worker CPU                 |                                                               10 ms/request | Browser performs rendering; Worker authorization and streaming stay small. |
| Worker memory              |                                                                      128 MB | Final MP4 is streamed, never fully buffered by the edge Worker.            |
| Worker subrequests         |                                                                  50/request | Current bounded DO/MediaStore/runtime routing is well below this.          |
| Request body               |                                                 100 MB on Free account plan | Application remains stricter: final 64 MiB, other uploads lower.           |
| Static asset files         |                                                 20,000/version, 25 MiB each | The 32,232,419-byte WASM is split into two verified files.                 |
| Durable Objects on Free    |                                                         SQLite backend only | Both classes use `new_sqlite_classes` migrations.                          |
| Durable Object usage       |                                       100,000 requests/day; 13,000 GB-s/day | Hibernatable sockets and small friend rooms remain required.               |
| DO SQLite storage          |                         5 GB total; 5M rows read/day; 100k rows written/day | App media uses bounded 1 MiB chunk rows; account storage is finite.        |
| R2 Standard Free allowance | 10 GB-month/month, 1M Class A and 10M Class B operations/month; egress free | Historical only; deployment is stopped and runtime R2 removal is next.     |

Official sources:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers Static Assets and SPA routing](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Objects pricing / Free SQLite constraints](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [R2 pricing and Free allowance](https://developers.cloudflare.com/r2/pricing/)
- [Free `workers.dev` subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Workers Response streaming and `encodeBody`](https://developers.cloudflare.com/workers/runtime-apis/response/)

## Historical ffmpeg runtime architecture (obsolete)

Pinned packages are `@ffmpeg/ffmpeg` 0.12.15 and single-thread `@ffmpeg/core` 0.12.10.
The table and R2 route description below record the retired 2026-09-12 design. See
`R2_FREE_FFMPEG_RUNTIME.md` for the active static multipart architecture.

| Fixed R2 key                              |      Bytes | SHA-256                                                            | MIME               |
| ----------------------------------------- | ---------: | ------------------------------------------------------------------ | ------------------ |
| `runtime/ffmpeg/0.12.10/ffmpeg-core.js`   |    111,804 | `67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3` | `text/javascript`  |
| `runtime/ffmpeg/0.12.10/ffmpeg-core.wasm` | 32,232,419 | `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7` | `application/wasm` |

The route table contains only the two public runtime names, never a user-provided key. GET/HEAD,
single byte ranges, `Accept-Ranges`, correct `Content-Range`, same-origin resource policy and
`public, max-age=31536000, immutable, no-transform` are supported. R2 bodies pass through a
`FixedLengthStream` with `Content-Encoding: identity` and Workers `encodeBody: "manual"`; this
prevents a 32 MiB WASM response from being recompressed/chunked and avoids Chromium cache-write
failure without buffering it in the Worker. R2 ETags are normalized exactly once. Missing objects
return controlled 503; unknown/traversal paths return 404. Application media is now in SQLite-backed
MediaStore objects; this runtime-only R2 path is the intentionally deferred dependency.

The old local/remote seed commands no longer exist.

## Upload policy

All limits are server-authoritative. MiB means 1,048,576 bytes.

| Input                   |            Limit | Processing                                           | Reason                                                             |
| ----------------------- | ---------------: | ---------------------------------------------------- | ------------------------------------------------------------------ |
| Scene source WebM/MP4   |   25 MiB, 10 min | Authorized stream into 1 MiB MediaStore chunks       | Browser metadata plus server MIME/signature checks.                |
| Accepted background M4A |           20 MiB | Authorized stream into 1 MiB MediaStore chunks       | 192 kbps stereo derivative; metadata and `ftyp` are revalidated.   |
| Thumbnail WebP/JPEG     | 512 KiB, 640×640 | One bounded MediaStore chunk plus image verification | Small presentation-only image with signature/dimension validation. |
| One line recording      |     5 MiB, 120 s | Authorized stream into 1 MiB MediaStore chunks       | MIME, ownership and canonical capture bounds are checked.          |
| Final MP4               |           64 MiB | Authorization first, then 1 MiB MediaStore chunks    | Avoids a 64 MiB isolate allocation.                                |

Final upload requires a valid participant capability, exact frozen manifest/result IDs,
`video/mp4`, a truthful bounded `Content-Length` and an MP4 `ftyp` prefix. The outer Worker asks
the room DO for authorization before reading the body, streams into a server-generated MediaStore
asset, and asks the DO to commit only after authoritative metadata reports the same size. A first
valid durable commit wins. The local MP4 remains in the host browser on failure, and the Turkish
UI states the 64 MiB ceiling without silently reducing quality.

Boundary tests accept the known 22,167,310-byte real-result size and exactly 64 MiB minus one byte,
and reject 64 MiB plus one, zero-length and unknown-length bodies before MediaStore streaming. Integration
tests cover normal streaming upload, invalid `ftyp`, wrong MIME, wrong room/player/manifest/result,
authorization before body preparation, first-valid-commit and idempotent retry. A production-like
real browser run committed and retrieved a 1,223,558-byte MP4 through this same streaming path.

## Application-media lifecycle

- Reusable Scene Studio source/background/thumbnail assets live in a scene-scoped MediaStore object
  until their owner replaces or deletes that scene. Room cleanup cannot affect that scope.
- Room source/background/recordings/result use the exact server-derived room MediaStore scope.
- Before final commit, every render input remains available for render/upload retry.
- After the authoritative result metadata is durably committed, one scoped SQL cleanup keeps only the
  exact committed MP4. Finished reconnect and participant download use only that MP4. Room expiry can
  delete the complete scope.
- A deliberately missing result object makes commit fail with 503 and leaves all six render inputs
  intact. Competing commits leave the winner retrievable and cannot delete it. Integration fixtures
  place room-private source/background assets in the room scope and a reusable Studio asset
  under `scenes/`; only the former are removed after the durable winning commit.
- Inactive/finished rooms retain the existing three-hour sliding TTL. Changing product retention is
  a future explicit decision, not silently invented here.

## Local AI security and browser boundary

Only Scene Studio imports and calls the companion client. Ordinary room participants never probe
port 8765 and need no Python or models.

The companion validates that `TAKETWO_AI_HOST` is loopback (`127.0.0.1`, `::1` or `localhost`),
uses an exact configurable `TAKETWO_AI_ALLOWED_ORIGINS` list, rejects disallowed browser Origins
before route execution, never uses wildcard CORS, and requires `X-Take-Two-Companion: 1` on actual
browser requests. That custom header forces a meaningful CORS preflight. Requests without an Origin
remain a deliberate CLI/test path on the same loopback interface.

The browser annotates companion fetches with experimental `targetAddressSpace: "loopback"` while
remaining compatible with browsers that ignore it. Where the Permissions API exposes
`loopback-network` / `local-network`, denial is reported separately from a stopped service. Turkish
messages cover stopped service, permission denial, origin allowlist rejection and missing models;
none recommends disabling browser security. Chrome LNA is permission-gated; WebKit/Safari and
Firefox support must be reported from actual testing rather than assumed.

No HF token, cache/model path, Worker binding or R2 credential enters the browser or companion
response. Model/cache variables are local-machine-only.

## Security headers

Every non-101 Worker response receives:

- `X-Content-Type-Options: nosniff` and explicit media/runtime MIME types.
- `Referrer-Policy: no-referrer` so capability-bearing context cannot leak in referrers.
- `X-Frame-Options: DENY` plus CSP `frame-ancestors 'none'` against framing.
- CSP default/self controls; `script-src 'self' 'wasm-unsafe-eval'` permits only WebAssembly
  compilation required by ffmpeg (not general `'unsafe-eval'`); `worker-src 'self' blob:` for
  ffmpeg; `media-src 'self' blob:` and `img-src 'self' blob: data:` for reviewed
  takes/results/thumbnails; `connect-src` for same-origin HTTP/WSS and the two explicit loopback
  companion names; the current policy also permits `blob:` connect only for the locally reconstructed
  ffmpeg WASM; no objects or foreign scripts.
- Permissions Policy disables camera/geolocation/payment/USB and allows microphone only to self.

Runtime objects are intentionally public immutable code. API JSON and all private source,
background, thumbnail, recording and result responses remain `no-store` / `private, no-store`.

## Capability / privacy audit

Studio and room tokens are 256-bit values from Web Crypto; only SHA-256 hashes persist server-side.
They travel in headers or the WebSocket AUTH payload, never URLs. Room codes alone reveal only the
bounded public summary. Route regexes accept constrained IDs, server code constructs every private media reference,
and no API accepts an asset/chunk identifier from a browser. Frozen manifests and result commits are
revalidated inside the room DO. Existing negative tests cover wrong owner/player tokens, other
rooms/scenes/lines, forged manifest/result IDs, host-only commands and hibernation restoration.

Internal stored metadata includes server-generated MediaStore references because cleanup/render resolution needs
them. They cannot be used by any browser route. No log
statement prints Authorization headers, tokens, request bodies, transcripts or private media.
There is no analytics or telemetry.

Configuration classes:

- Public build: optional `VITE_API_BASE_URL`, `VITE_AI_COMPANION_URL`; never secrets.
- Worker bindings/vars: `ROOMS`, `SCENE_STUDIO`, `MEDIA_STORE`, `ASSETS`,
  `ALLOWED_ORIGINS`, `ROOM_TTL_MS`.
- Worker secrets: none currently.
- Local AI only: `HF_TOKEN`, model/cache/device variables, `TAKETWO_AI_ALLOWED_ORIGINS`.

## Static build audit

`npm run production:audit` now fails on any file at or above 25 MiB, a monolithic ffmpeg WASM,
missing/corrupt multipart runtime files, reconstructed hash mismatch, active Wrangler R2 bindings,
private-key/HF-token patterns, or generated/private directory names. Current measurements are in
`R2_FREE_FFMPEG_RUNTIME.md`.

## Browser compatibility and production-like smoke

| Engine / shape                     | Automated result                                             | Honest boundary                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium desktop + emulated mobile | 12 passed, 4 intentional private-media/mobile-hardware skips | Desktop guided recording and private Studio passed; physical microphone/device remains manual.                                                                         |
| Firefox Playwright 155             | 6/6 relevant non-hardware flows passed                       | Real microphone/MediaRecorder and final MP4 on physical Firefox remain manual.                                                                                         |
| Playwright WebKit 26.6 on Windows  | 6/6 relevant flows passed                                    | This is not Safari hardware. Its WebM decoder reports support but cannot read the fixture; graceful Turkish media errors and the remaining room/recovery flows passed. |

The single-Worker production simulation passed SPA deep links, `/api/health`, security headers,
DO room creation, real WebSocket AUTH, exact runtime byte ranges and the WASM magic bytes. The same
origin then loaded the full 32,232,419-byte WASM from local R2 with identity encoding, rendered a
30.0-second H.264/AAC MP4 from six canonical recordings, excluded source-film audio by the reviewed
composition map, historically streamed the 1,223,558-byte result to R2 in 4,492 ms, and proved identical
SHA-256 `5e1ccfd99e2e11c889017479154ef155b76358fc4985894fda1b3d5d2bb8af61` for host and guest downloads
after finished-room restoration.

Final automated evidence: frontend/shared Vitest 155/155; Worker/domain/storage/Miniflare 63/63;
Python companion 57 passed with 2 expensive/model opt-ins skipped; TypeScript, ESLint, Prettier,
Ruff lint/format, production Vite build, Wrangler dry-run, runtime checksum, static audit, Vite
watch/reload and combined dev lifecycle all passed. The expensive cinematic/speaker model behavior
was not changed or rerun.

## Known manual-only risks

- Chrome's real production HTTPS LNA prompt must be accepted by the scene owner.
- Physical Safari/iPhone, Firefox devices, microphones and hardware codec matrices need manual QA.
- The Playwright WebKit-on-Windows WebM limitation means real Safari must be tested with the actual
  deployed source formats; final MP4 playback on those physical devices remains manual-only.
- A 64 MiB browser render still needs substantial client memory; the server stream does not remove
  ffmpeg.wasm's device-side memory cost.
- Free quotas are hard ceilings: exhaustion causes failures. Usage must be observed after deployment.
- Studio ownership stays browser-local; clearing that browser storage loses management access.

See `CLOUDFLARE_FREE_DEPLOYMENT_TR.md` for the next checkpoint. Do not execute it during readiness.
