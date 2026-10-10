# Phase 11B2B background integration

Phase 11B2B is the production-path integration of the provisionally approved CDX23
dialogue-removal result. It does not deploy or publish anything. Separation stays on the
developer's loopback companion, private media stays in the local browser/companion and
SQLite MediaStore, and model weights remain ignored local files.

## Product flow

1. Scene Studio retrieves the authorized private source as a Blob.
2. The browser submits that Blob to the existing `127.0.0.1:8765` companion and polls the
   separation job through queued, loading, separating and encoding stages.
3. CDX23 produces speech, music and effects in an isolated subprocess. The product output
   is exactly the dialogue-free `music + effects` signal.
4. PyAV encodes the candidate as AAC-LC/M4A at approximately 192 kbps, 44.1 kHz stereo.
   Float32 WAV is deliberately not persisted: for a 42.121 s clip it would be about
   14.9 MB, while the product M4A is 1,022,472 bytes and remains directly usable by the
   browser and ffmpeg.wasm.
5. Studio previews a local object URL. Generation does not mutate the scene. The user must
   explicitly accept with **Arka Planı Kullan**.
6. The owner-authorized Worker validates and stores the accepted M4A in SQLite MediaStore chunks, then
   persists server-owned metadata/reference on the preparation draft and canonical scene.
7. Room creation copies that exact object under the room prefix. The scene snapshot and
   frozen manifest reference only the room-private render route.
8. The authorized renderer fetches the exact frozen background, mixes it with frozen
   player recordings and muxes only the source video track plus the newly mixed audio.

## Provider and provenance

The stable provider boundary is `local-cinematic-separator` version 1. The current provider
uses official CDX23 DnR checkpoint B (`97d170e1-dbb4db15.th`, 53,916,935 bytes, SHA-256
`dbb4db154df7e45a5cb72d1659c48937e757f6d6b0eef8ca4199e6e38f8d8f37`). CDX23 source
code is MIT. The release does not separately state a checkpoint-weight license; therefore
this is a provisional local provider, not a claim that the weights can be distributed as a
permanent public/open-source product dependency. Weights are not committed or rehosted.
The boundary permits a future Bandit v2 provider without changing Studio/Worker contracts.

## Storage and authorization contract

The product asset is `audio/mp4` with an MP4 `ftyp` signature, AAC-LC content, approximately
192 kbps, 44.1 kHz and two channels. The Worker enforces a 20 MiB body limit, stereo,
bounded provenance fields and duration within 250 ms of the already stored scene source.
The server creates the background UUID and the
`scenes/{sceneId}/background/{backgroundId}.m4a` key; client object keys are ignored.

Replacement is transactional at the application boundary: write the new object, durably
commit the new draft/reference, then best-effort delete the old scene object. A failed
validation/upload cannot remove background A. Scene deletion cleans the scene-owned source
and current background. Neither operation touches existing room prefixes.

Room creation copies the source and accepted background before committing the room. A room
made with A keeps A even if Studio later accepts B or deletes the scene; a later room gets
B. Room expiry deletes the whole room prefix. The render-background route requires a valid
current participant token, exact room/player IDs, `processing` state, exact manifest ID,
the manifest's canonical room background URL and the room-owned object. Responses are
private and non-cacheable. No public URL, R2 key, prefix listing or R2 credential is exposed.

## Render invariant

The mix command mounts only accepted background audio (when present) and every frozen
recording. Each input is resampled to 48 kHz stereo, reset to time zero, padded/trimmed to
scene duration and gain-adjusted. Background starts at scene time zero at volume 0.35.
Player voice starts at `captureStartMs ?? startMs` at volume 0.9. Overlaps remain overlaps.
The sum uses deterministic `amix`, limiter 0.95 and AAC 160 kbps.

The final command is structurally:

```text
-i source.(mp4|webm) -i dub-mix.m4a
-map 0:v:0 -map 1:a:0 ... -c:a copy ... dubbed-scene.mp4
```

It never maps `0:a:0`. With a background, final audio is accepted background plus player
voices. Without one, it is player voices only. A missing accepted background is a visible
`BACKGROUND_FAILED` error and never falls back to original movie audio. Private MP4 input
is mounted from response MIME as MP4 and its browser-validated video track is stream-copied;
WebM video is transcoded to H.264. The unstable standalone ffmpeg.wasm metadata probe was
removed, so production uses only the mix and final mux commands.

## Lifecycle and limits

Normal product jobs use job-scoped safe filenames. Source and intermediate stems are
removed on success, failure or cancellation. A completed compressed candidate is retained
for at most 30 minutes or until the browser downloads and deletes the job. A daemon timer
enforces expiry without another request; startup sweeps only expired folders matching the
safe job prefix after a crash. This lifecycle does not touch intentional Phase 11B2A
evidence under `local-test-media/separation-eval/**`.

The later production-hardening checkpoint raised the final-result ceiling to an intentional
64 MiB, and the R2-free media checkpoint stores that stream as 1 MiB SQLite chunks. Browser
ffmpeg memory and performance remain practical limits for longer or higher-bitrate sources.

## Real local evidence

The authorized private `local-test-media/clip1-speaker-regression.mp4` completed the actual
Studio → loopback companion → preview/accept → private SQLite MediaStore → room copy → frozen
manifest → secure render inputs → ffmpeg.wasm → committed shared result path. Source was
42.121 s. CUDA inference was approximately 6.70 s. Background was 1,022,472 bytes, 44.1
kHz stereo, with exact decoded sample count and no observed alignment shift. Final output
was about 21.8 MiB and 42.11 s; the shared-result player loaded it successfully. Synthetic
Web Audio/MediaRecorder supplied the player take. No private media left the local/dev
environment.

## Manual acceptance

```powershell
npm.cmd run ai:dev
npm.cmd run dev:all
```

Open Scene Studio, prepare/select the real scene, generate the dialogue-free background,
preview it, explicitly accept/save it, create a room, dub normally, finish the render and
listen to the final video. No WAV, Python, checkpoint, R2 key, JSON or ffmpeg interaction is
part of the user flow.
