# Take Two

Türkçe: [README.tr.md](README.tr.md)

Take Two is an original, free web dubbing party game. A small private group
connects from different homes, joins a coded room without registration, records
assigned dialogue line by line, and shares one MP4 result. The user interface
is Turkish. No dublaj.io code, branding, or protected content is used.

**Maintenance status: inactive.** Development is no longer active. This
repository preserves source code and documentation so the project can be
restored later. See [docs/ARCHIVAL.md](docs/ARCHIVAL.md). There is no support,
no roadmap, and no planned feature work.

## Features

- Scene library, coded rooms, live lobby, presence, ready state, reconnect.
- Server-authoritative start, deterministic character assignment, host migration.
- Guided per-line recording with 3–2–1 cue, review before confirm, server-validated upload.
- Frozen renderer manifest, browser-side H.264/AAC MP4 composition, shared playback/download.
- Private Scene Studio: prepare owned WebM/MP4 clips into canonical scenes with
  characters, millisecond dialogue windows, thumbnails, and optional background audio.
- Optional local AI companion for draft transcription/diarization and
  dialogue-free background candidates. Manual correction is always required.

## Architecture and stack

- Frontend: React 19, strict TypeScript 5, Vite 7, Tailwind 4, React Router 7, Zod 4.
- Backend: one Cloudflare Worker (`worker/index.ts`), hibernatable WebSockets.
- Storage: three SQLite Durable Objects — `ROOMS` (`GameRoom`),
  `SCENE_STUDIO` (`SceneStudio`), `MEDIA_STORE` (`MediaStore`).
- Shared contracts: `shared/schemas` (Zod), `shared/types`, `shared/scenes`.
- Rendering: lazy single-thread ffmpeg.wasm (`@ffmpeg/ffmpeg` 0.12.15,
  `@ffmpeg/core` 0.12.10), WORKERFS, 48 kHz stereo mix, source video only.
- AI companion (optional, Windows-local): FastAPI on loopback `127.0.0.1:8765`,
  faster-whisper word timestamps, pyannote diarization, local separation providers.
- Tests: Vitest/RTL/jsdom, Miniflare Worker integration, Playwright Chromium/Firefox/WebKit.

See [docs/ROOM_PROTOCOL.md](docs/ROOM_PROTOCOL.md) for the room lifecycle and
security model.

## R2-free deployment architecture

Production and development have zero R2 bindings.

- Application media lives in `MEDIA_STORE` as committed metadata plus ordered
  1 MiB SQLite chunks. Uploads authorize before the body is consumed; reads are
  private and support HEAD/single-range. Room expiry and post-final cleanup are
  scope-confined.
- The 32,232,419-byte ffmpeg core WASM is split by `npm run runtime:prepare`
  into two versioned Workers Static Assets below 25 MiB
  (`ffmpeg-core.wasm.part-000` + `part-001`). The browser verifies each part and
  the reconstructed SHA-256 before loading ffmpeg. No runtime CDN is used.
- Final MP4 upload is authorization-first, MP4-`ftyp`-validated, streamed into
  1 MiB rows with a deliberate 64 MiB ceiling. First durable commit wins.
- One Worker origin serves the SPA (`dist/` with SPA fallback), `/api/*`,
  WebSockets, private media, and runtime assets.

Further detail: [docs/R2_FREE_MEDIA_STORAGE.md](docs/R2_FREE_MEDIA_STORAGE.md),
[docs/R2_FREE_FFMPEG_RUNTIME.md](docs/R2_FREE_FFMPEG_RUNTIME.md),
[docs/PRODUCTION_HARDENING.md](docs/PRODUCTION_HARDENING.md).

## Local development

Requirements: Node.js 24 LTS (>= 24.15) and npm. Engine ranges are in `package.json`.

```sh
npm ci
npm run dev:all
```

Open `http://127.0.0.1:5173`. The local Worker listens on `http://127.0.0.1:8787`.
`runtime:prepare` runs automatically before dev/build and regenerates the ignored
`public/runtime/` files from the installed `@ffmpeg/core` package. No Cloudflare
account is needed locally. Leave `VITE_API_BASE_URL` unset to use the Vite `/api`
proxy. See `.env.example` for documented variables.

### Windows quick setup

Double-click **`Kurulum.bat`** in the repository root (or run `Kurulum.bat web`
from a terminal). It reuses only the existing project scripts:

- Reuses a compatible Node.js when one is on `PATH`; otherwise downloads the
  pinned portable Node 24.20.0 from the official nodejs.org distribution into
  ignored `.tools/` and verifies its SHA-256. No admin rights, no global install.
- Installs locked dependencies (`npm ci`, skipped when already in sync),
  prepares and verifies the ffmpeg runtime checksums, and verifies the build.
- `Kurulum.bat full` additionally sets up the Python/uv AI environment through
  the existing `ai-setup` CPU path; `Kurulum.bat full-cuda` uses the existing
  CUDA path. Model weights are never downloaded automatically: gated models
  (notably `pyannote/speaker-diarization-community-1`, CC BY 4.0) still require
  manual Hugging Face condition acceptance, a free token set as `HF_TOKEN` in
  the terminal only, and `npm run ai:models`. CDX23 checkpoint weights are
  license-uncertain and stay manual and local-only.

The installer is repeat-safe: valid existing downloads are reused and completed
steps are skipped.

Useful commands:

| Command                    | Purpose                                  |
| -------------------------- | ---------------------------------------- |
| `npm run typecheck`        | Strict TypeScript (app + Worker)         |
| `npm run lint`             | ESLint, zero warnings                    |
| `npm test`                 | Vitest + Worker/Miniflare suites         |
| `npm run build`            | Typecheck + Vite build + Worker dry-run  |
| `npm run check`            | Typecheck, lint, tests, build            |
| `npm run runtime:verify`   | Verify prepared ffmpeg parts (read-only) |
| `npm run production:audit` | Audit `dist/` size and exclusions        |
| `npm run format:check`     | Prettier check                           |

Browser suites (`test:browser`, `test:render`, `test:production`, `test:compat`)
need a build and Playwright browsers. Screenshots/traces go to ignored
`test-results/`.

## Optional AI companion

The game works without AI. Setup is explicit and multi-GB:

```powershell
npm.cmd run ai:setup
$env:HF_TOKEN = 'hf_...'
npm.cmd run ai:models
npm.cmd run ai:dev
```

CPU is the default. CUDA setup (`ai:setup:cuda`) needs compatible CUDA 12
cuBLAS/cuDNN 9 libraries. Model weights download into ignored `ai/.cache/` and
are never committed. Full privacy, cache, and troubleshooting details are in
[`ai/README.md`](ai/README.md).

## AI models and third-party licensing

MIT in [LICENSE](LICENSE) covers only the original code in this repository that
we are entitled to license. Third-party packages, models, and weights keep their
own licenses. Model weights are excluded from this repository.

- `faster-whisper` (`small` default, ~486 MB): MIT-licensed code/model packaging
  as distributed upstream; downloaded locally, never committed.
- `pyannote/speaker-diarization-community-1`: the official model page currently
  identifies **CC BY 4.0**. Access is gated and requires Hugging Face condition
  acceptance plus a free `HF_TOKEN`. Weights are local-only.
- Bandit v2 separation: inference code Apache-2.0, official Zenodo v2 Multi
  weights CC-BY-SA-4.0. Weights are checksum-verified locally, never committed
  or rehosted.
- CDX23 DnR checkpoint B (provisional fallback): separation code is MIT, but the
  upstream release does not state a separate weights license. Weights stay in
  ignored local cache only; they are not committed, distributed, or implied to
  be MIT-licensed.
- `@ffmpeg/ffmpeg` 0.12.15 / `@ffmpeg/core` 0.12.10: used under their upstream
  npm licenses; the WASM artifact is verified by SHA-256 and regenerated from
  `node_modules`, never committed.
- Other npm dependencies: see `package.json` / `package-lock.json` for versions
  and upstream licenses.

Only use scenes and media you own, created, licensed, or are authorized to use.
Never add unauthorized film, TV, game, or third-party clips. Built-in fixtures
under `public/scenes/` are original: a silent 30-second development animation
for `a-small-step`, plus original SVG posters and Turkish demo scripts. See
[public/scenes/README.md](public/scenes/README.md).

## Historical deployment and shutdown plan

On 2026-09-13 the Worker `take-two-rooms` was deployed to
`https://take-two-rooms.take-two.workers.dev` on the card-free Workers path with
zero R2 bindings. Remote smoke, a safe-fixture render/share pass, and
same-machine Chrome acceptance passed. Different-home multiplayer acceptance
never ran.

The deployment is planned to be shut down after GitHub publication is verified.
Shutdown is not implemented in this change. See [docs/ARCHIVAL.md](docs/ARCHIVAL.md)
and [docs/SHUTDOWN_CHECKLIST.md](docs/SHUTDOWN_CHECKLIST.md). Durable Object
data removal (`ROOMS`, `SCENE_STUDIO`, `MEDIA_STORE`) requires separate
verification against current Cloudflare documentation; do not assume Worker
deletion alone permanently removes all DO data.

## Repository contents

Tracked: `src/`, `shared/`, `worker/`, `tests/`, `docs/`, `scripts/`,
`ai/src/`, `ai/tests/`, `ai/scripts/`, `ai/README.md`, `public/scenes/`,
configs (`package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`,
`wrangler.jsonc`, `wrangler.dev.jsonc`, Playwright configs), `.env.example`,
`index.html`, `LICENSE`, `README.md`, `README.tr.md`, `AGENTS.md`,
`Kurulum.bat` (Windows one-click setup; implementation in `scripts/kurulum.ps1`).

Excluded via `.gitignore`: `node_modules/`, `dist/`, `.tools/`, `.wrangler/`,
`.worker-build/`, `ai/.venv*/`, `ai/.cache/`, `local-test-media/`,
`test-results/`, `public/runtime/` (regenerated), `.ruff_cache/`,
`memory-bank/` (local-only internal notes), credentials (`.env`, `.dev.vars`).

## License

MIT © 2026 akcealan. See [LICENSE](LICENSE). The license applies only to
original repository content. Third-party components retain their own licenses
and requirements as noted above. No warranty is provided.
