# R2-free ffmpeg runtime packaging

Date: 2026-09-13. This checkpoint removes the final R2 dependency without deploying or changing
accepted game, AI, or application-media behavior.

## Previous path

`BrowserDubRenderer` passed `/api/runtime/ffmpeg-core.js` and `/api/runtime/ffmpeg-core.wasm` to
`@ffmpeg/ffmpeg`. The Worker mapped only those routes through `worker/runtimeAssets.ts` into fixed
`RUNTIME_ASSETS` keys. The R2 response layer implemented GET/HEAD/Range, MIME, immutable caching,
identity encoding, fixed-length streaming and ETag normalization. `scripts/seed-runtime-assets.mjs`
verified the installed package and seeded either local Miniflare or a future remote bucket. Both
Wrangler files, Worker environment typing, Miniflare suites, Playwright servers, readiness tests and
the remote smoke script assumed that bucket.

## Current static architecture

`npm run runtime:prepare` reads only the installed `@ffmpeg/core` 0.12.10 ESM distribution. It fails
closed on package version, source size or source SHA-256 changes. It copies the verified JavaScript,
splits the canonical WASM at a deterministic 16 MiB boundary, writes only changed outputs under
`public/runtime/ffmpeg/0.12.10/`, then reconstructs and hashes the output. `runtime:verify` is a
read-only equality and reconstruction check. No network, Wrangler, bucket or credential is involved.

The generated/source manifest is `shared/runtime/ffmpeg-manifest.json` and is used by browser,
Worker routing, packaging, audit and smoke logic.

| Static file                 |      Bytes | SHA-256                                                            |
| --------------------------- | ---------: | ------------------------------------------------------------------ |
| `ffmpeg-core.js`            |    111,804 | `67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3` |
| `ffmpeg-core.wasm.part-000` | 16,777,216 | `4ccba0c9cc7f019751a958ead3918cf51c9563ff2f8a76fb1f72ae492f66693b` |
| `ffmpeg-core.wasm.part-001` | 15,455,203 | `80e8b2ae7994e92102e048249ab0a6673480ca626c359b1d321b24f105f02e65` |

Reconstruction is exactly 32,232,419 bytes with SHA-256
`9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`.

The browser fetches the fixed ordered part list with normal full same-origin GETs. It checks response
status, each byte size and part SHA-256, copies each part into one preallocated final buffer, and checks
the full SHA-256 through Web Crypto. A temporary `application/wasm` Blob URL is passed to ffmpeg and
revoked when `load()` settles. Range requests are not required. Peak packaging-specific live data is
approximately the 32 MiB output plus one ~16 MiB response, with transient digest/Blob implementation
overhead; the ffmpeg engine's own WebAssembly memory remains separate.

Workers Static Assets owns transport, ETags and any platform compression behavior. The Worker allows
only the manifest-listed versioned paths in the runtime namespace, makes them read-only, and adds
`public, max-age=31536000, immutable, no-transform` plus same-origin resource policy. CSP remains
`script-src 'self' 'wasm-unsafe-eval'`; broad `unsafe-eval` was not added. `connect-src` includes only
the existing endpoints plus `blob:` so the ffmpeg Worker can fetch the locally reconstructed in-memory
WASM; this first real render check caught and verified that narrow requirement. The old custom range,
fixed-length, content-encoding and ETag workaround is obsolete.

`production:audit` rejects every file at or above 25 MiB, a monolithic `ffmpeg-core.wasm`, missing or
corrupt expected runtime files, a failed reconstructed hash, forbidden private/generated content, and
any active R2 binding in either Wrangler configuration.

Both Wrangler configurations now have zero R2 bindings. Application media remains in `MEDIA_STORE`;
the runtime is normal static code. Local development prepares idempotently before `dev`/`dev:all` and
does not seed Miniflare. The generated runtime directory is excluded from Vite watch registration, so
preparation cannot create HMR watcher churn. No Cloudflare command, remote upload, AI inference or Git
initialization was performed by this checkpoint.

## Final local evidence

- 161 frontend/shared tests and 64 Worker/domain/Miniflare tests passed; TypeScript and zero-warning
  ESLint passed; changed files passed Prettier.
- Vite production build, the static/integrity audit and Wrangler dry-run passed. Wrangler reported only
  `ROOMS`, `SCENE_STUDIO`, `MEDIA_STORE`, `ASSETS` and the two ordinary variables.
- Single-Worker SPA root/deep-link, API, DO, WebSocket, headers and browser reconstruction smoke passed
  in 718 ms.
- Single-Worker Chromium loaded/reconstructed/verified the runtime in 543 ms (416 ms reconstruction,
  127 ms ffmpeg initialization), rendered and committed a 30 s H.264/AAC MP4 in 3,914 ms, and produced
  1,220,582 bytes with SHA-256
  `d7e96075e24d9713fe309002ebf6ce4856b9ca6c3fa37ddb6b424ab5ec1ab1ec`. It observed exactly two part
  requests and zero `/api/runtime/*` requests.
- The separate Vite + Worker render produced a 1,222,297-byte result in 3,899 ms. The full real
  MediaStore regression produced 22,331,088 bytes in 3,916 ms after room freeze and confirmed
  post-final source cleanup. The `dev:all` lifecycle passed with no runtime seed.

No cinematic AI inference ran. No private media/model left the machine. No Cloudflare login, remote
resource, deployment, Git or GitHub action occurred.
