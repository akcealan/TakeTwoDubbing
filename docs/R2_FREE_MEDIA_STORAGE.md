# R2-free application media storage

## Checkpoint constraints

Cloudflare R2 was rejected for this deployment because enabling it requires account-level
subscription/checkout activation. This project has a hard **0 TL, no card, no billing subscription,
no paid service** requirement. This checkpoint does not enable R2, authenticate Wrangler, create
remote resources, deploy, initialize Git, or change ffmpeg runtime packaging.

The design authority is Cloudflare's current Durable Objects documentation. SQLite-backed Durable
Objects are available on Workers Free. The account-wide Free storage allowance is finite (5 GB), and
an individual SQLite string, BLOB, or row is limited to 2 MB. Application media therefore uses
1 MiB (1,048,576-byte) chunks, well below the row/BLOB ceiling.

## Pre-implementation storage migration map

The production `RECORDINGS` binding is used by all of the following paths. This map was recorded
before implementation; generated Worker bundles and test-only direct R2 inspection are not production
call sites.

| Media/operation                     | Existing production location                                                                                                                      | Existing behavior to preserve                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Scene source upload                 | `worker/index.ts` buffers the request; `SceneStudio.ts` validates and calls `RECORDINGS.put`                                                      | Owner-only, WebM/MP4 signature and 25 MiB limit, server-generated identity, metadata commit after bytes         |
| Scene source GET                    | `SceneStudio.ts` calls `RECORDINGS.get`                                                                                                           | Owner-only private stream with authoritative MIME/length                                                        |
| Scene background upload/replacement | `worker/index.ts` buffers; `SceneStudio.ts` calls `put`, commits metadata, deletes old key                                                        | Explicit acceptance, AAC/M4A signature/metadata, commit-first replacement, failed replacement retains old asset |
| Scene background GET                | `SceneStudio.ts` calls `get`                                                                                                                      | Owner-only private read                                                                                         |
| Scene thumbnail upload/replacement  | `worker/index.ts` buffers; `SceneStudio.ts` calls `put`, commits metadata, deletes old key                                                        | Owner-only WebP/JPEG validation, commit-first replacement                                                       |
| Scene thumbnail GET                 | `SceneStudio.ts` calls `get`                                                                                                                      | Owner-only private presentation read; never copied to rooms                                                     |
| Scene delete                        | `SceneStudio.ts` deletes source/background/thumbnail keys                                                                                         | Deletes only scene-owned media                                                                                  |
| Room source copy/freeze             | `worker/index.ts` gets the scene source body and puts it under `rooms/{roomId}`                                                                   | Bounded server-side copy, immutable room A after scene B replacement/deletion                                   |
| Room background copy/freeze         | `worker/index.ts` gets and puts accepted scene background                                                                                         | Exact accepted-version room copy; rollback source copy on failure                                               |
| Room source GET                     | `GameRoom.ts` via `TemporaryRecordingStorage.get`                                                                                                 | Participant-only source playback/read                                                                           |
| Room background GET                 | `GameRoom.ts` via `TemporaryRecordingStorage.get`                                                                                                 | Participant + processing + exact manifest authorization                                                         |
| Line recording upload/replacement   | `worker/index.ts` and `GameRoom.ts` buffer; `TemporaryRecordingStorage.put/delete`                                                                | Session/ownership/canonical timing/MIME validation, 5 MiB, write+metadata commit+old delete                     |
| Line recording renderer GET         | `GameRoom.ts` gets R2 object then calls `arrayBuffer()`                                                                                           | Participant + processing + exact frozen-manifest authorization                                                  |
| Final MP4 upload                    | `worker/index.ts` authorizes first then streams to `RECORDINGS.put`; a legacy direct `GameRoom.ts` branch uses `TemporaryResultStorage.putStream` | MP4 signature, exact length, 64 MiB, first valid durable commit wins                                            |
| Final MP4 GET/download              | `GameRoom.ts` via `TemporaryResultStorage.get`                                                                                                    | Participant-only finished-result playback/download and restoration                                              |
| Successful-final cleanup            | `TemporaryRecordingStorage.deleteRoomExcept` lists/deletes room-prefix objects except result                                                      | Remove frozen source/background/recordings only after authoritative result commit                               |
| Room expiry cleanup                 | `TemporaryRecordingStorage.deleteRoom` lists/deletes the room prefix                                                                              | Remove all room-owned media                                                                                     |

Existing GET paths generally advertise or depend on media byte behavior but do not consistently forward
`HEAD`/`Range`; the new backend makes GET, HEAD, and one byte range explicit and consistent without
assembling whole assets.

## Implemented architecture

`MediaStore` is a dedicated SQLite-backed Durable Object class. The Worker and domain Durable Objects
address server-controlled instances named `scene:<sceneId>` and `room:<roomId>` through an internal
client abstraction. Browsers continue to use only existing authorized Worker routes and never see a
Durable Object ID, internal route, chunk number, SQL key, or storage path.

`worker/storage/mediaStore.ts` is the only application-media storage implementation. Its
`MediaStoreClient` gives Worker and domain Durable Objects an asset-level API (`put`, `get`, `head`,
`delete`, `cleanup`, `retainOnly`) so route code never contains chunk SQL. `copyMediaAsset` streams a
committed asset from a scene scope into a room scope. The browser cannot invoke the internal protocol:
all public traffic still passes through the existing owner/player/room-authorized routes, which strip
internal asset metadata before returning a response.

Scopes are server-derived and restricted to `scene:<private-scene-id>` and `room:<room-uuid>`. Asset IDs
are generated on the server and are kept only in private SceneStudio/GameRoom wrapper state. Canonical
scenes, public rooms, recording manifests and result metadata contain stable product metadata, never DO
IDs, SQL rows, chunk indices or storage paths.

## SQLite schema and limits

Each scoped MediaStore object owns these tables:

```sql
assets(
  asset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  committed INTEGER NOT NULL
)

asset_chunks(
  asset_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  bytes BLOB NOT NULL CHECK(length(bytes) <= 1048576),
  PRIMARY KEY(asset_id, chunk_index),
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE
)
```

The exact chunk size is **1 MiB = 1,048,576 bytes**. The schema check makes a larger BLOB impossible,
leaving substantial room below Cloudflare's 2 MB SQLite row/BLOB limit. Empty bodies are rejected.
Asset bounds remain product-specific: 25 MiB scene/room source, 20 MiB scene/room background, 512 KiB
thumbnail, 5 MiB recording, and 64 MiB final MP4.

## Streaming upload and commit

Every public route performs its existing owner/player/session/canonical-state authorization before the
body is consumed. Content-Length, declared MIME and product metadata are validated first. MediaStore
then reads the one logical request stream incrementally, accumulates at most one 1 MiB storage chunk,
writes monotonically generated chunk indices, and retains only the small signature prefix needed for
WebM/Ogg, MP4/M4A, WebP or JPEG validation.

An asset starts with `committed = 0`, so it is invisible to reads. Oversize, stream interruption,
signature failure or metadata/count mismatch deletes the candidate asset and cascades its chunks. A
successful transaction verifies the stored byte/chunk totals and flips the asset to committed. The next
request also removes any stranded uncommitted rows, covering isolate interruption. Replacement is
commit-first: domain metadata is updated only after the new asset commits, and the old committed asset
is deleted only after that update succeeds.

The 64 MiB result never becomes one Worker `ArrayBuffer`; the same streaming path produces exactly 64
full chunks for an exact 64 MiB body. A failed upload or a losing first-commit race deletes only its new
candidate and does not trigger room cleanup.

## Streaming GET, HEAD and byte ranges

Committed metadata is authoritative for `Content-Type`, `Content-Length`, `Accept-Ranges: bytes` and
range calculations. `HEAD` returns the same representation headers without reading chunks. `GET`
without a range creates a fixed-length sequential stream. One RFC-style byte range is supported,
including closed, open-ended and suffix forms:

- a satisfiable range returns `206` and exact `Content-Range`/`Content-Length`;
- an invalid, multiple or unsatisfiable range returns `416` with `Content-Range: bytes */<size>`;
- only chunks overlapping the requested interval are queried;
- the first and last chunk are sliced, while middle chunks pass through unchanged.

This covers a range inside one chunk, across chunks, starting or ending exactly at a boundary, and the
last byte without reconstructing the asset.

## Product semantics

- Scene source, accepted background and thumbnail remain owner-only. Background acceptance and
  thumbnail image checks remain explicit. Replacement keeps the old accepted object if any later step
  fails. Scene deletion cleans the scene scope only.
- Room creation streams the exact current source and accepted background from scene scope to a new room
  scope. The destination commits before room creation continues. Existing rooms therefore retain A
  after the Studio scene changes to B or is deleted; a new room receives B. Thumbnails are not copied.
- Line recordings retain the 5 MiB bound, MIME/signature rules, authenticated player/session checks,
  canonical line ownership, capture bounds, replacement order, progress and frozen-manifest rules.
  Recording bytes never enter GameRoom state.
- A final MP4 retains authorization-before-body, signature and 64 MiB rules. The first valid durable
  commit wins. All participants can play/download the same finished asset, including after hibernation
  or reconnect restoration.
- Only after a successful authoritative final commit, `retainOnly(finalAssetId)` removes the frozen room
  source/background and all line recording bytes. The final asset and required result metadata remain.
  Failed uploads/commits preserve existing media. Room expiry can clean the complete room scope in one
  SQL transaction.

## Free-tier hygiene

At 1,048,576 bytes per chunk, the maximum data-row counts are deterministic:

| Asset                 | Maximum bytes | Chunk rows |
| --------------------- | ------------: | ---------: |
| Scene/room source     |        25 MiB |         25 |
| Scene/room background |        20 MiB |         20 |
| Line recording        |         5 MiB |          5 |
| Final result          |        64 MiB |         64 |
| Thumbnail             |       512 KiB |          1 |

Each asset also has one small metadata row; SQLite indexes and database overhead consume additional
space. This product targets a small friend group and does **not** claim unlimited storage. Cloudflare's
Workers Free SQLite Durable Object allowance is currently 5 GB account-wide, so stored scenes and final
results must be managed within that finite ceiling. Platform authority: [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and the [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Wrangler and local-state impact

Both `wrangler.jsonc` and `wrangler.dev.jsonc` bind `MEDIA_STORE` to the new SQLite `MediaStore` class and
add migration tag `v3` with `new_sqlite_classes: ["MediaStore"]`. The `RECORDINGS` binding is absent.
Application media therefore needs no R2 binding in local Miniflare or production configuration.

Existing `.wrangler` data and old local R2 objects were deliberately left untouched. There is no risky
broad migration: previously created local scenes/rooms whose private state references only old R2 keys
must be recreated. Extra legacy fields are ignored safely rather than crashing parsing, and every newly
created scene uses MediaStore. At that historical checkpoint, `RUNTIME_ASSETS` was the only remaining
R2 binding; it was subsequently removed by **R2-FREE FFMPEG RUNTIME PACKAGING**. The current production
architecture has zero R2 bindings.

## Verification evidence

- Final deterministic suites passed 155/155 frontend/shared tests and 65/65 Worker/Miniflare tests,
  with TypeScript, zero-warning ESLint, Prettier, production build/static audit, Wrangler dry-run,
  development lifecycle and local single-Worker production smoke also passing. Normal Chromium passed
  12 flows with four intentional mobile/private-hardware skips.
- Focused MediaStore tests cover empty, one/multiple/exact/short chunks, metadata, full GET, HEAD,
  in-chunk/cross-chunk/boundary/final-byte/invalid ranges, oversize, interruption rollback, delete,
  scope cleanup, streamed cross-scope copy and byte equality. An exact 64 MiB test proves 64 rows and a
  final-byte range.
- Worker/Miniflare integration covers Studio source/background/thumbnail upload/read/replacement,
  source/background room freeze, recording upload/read, finalization, render inputs, result
  upload/read/HEAD/range, cleanup, deletion, authorization negatives and restoration.
- Local Chromium product smoke used only ignored local fixtures: 22,167,310-byte source,
  1,022,472-byte accepted background, generated microphone recording and real ffmpeg.wasm. It deleted
  the Studio scene after room creation, rendered and committed a 22,330,803-byte result, downloaded the
  same result, and observed room source `404` after successful final cleanup. No AI inference, external
  media upload, Cloudflare login/resource creation or deployment occurred.
