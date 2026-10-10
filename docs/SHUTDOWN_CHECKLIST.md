# Cloudflare shutdown checklist (not executed)

This checklist prepares the safe retirement of the historical production
deployment. Do not execute any step here until GitHub publication is verified
and the user gives explicit approval for each irreversible action. No shutdown
command was run as part of publication preparation.

## Current state (2026-09-13 deployment)

- Worker: `take-two-rooms` at `https://take-two-rooms.take-two.workers.dev`.
- Bindings: `ROOMS` (`GameRoom`), `SCENE_STUDIO` (`SceneStudio`), `MEDIA_STORE`
  (`MediaStore`), all SQLite Durable Objects; plus `ASSETS` Static Assets.
- R2 bindings: zero. No bucket was created.
- Stored data includes room state, scene preparation metadata, and private media
  bytes (sources, backgrounds, thumbnails, recordings, final MP4s) inside DO
  storage. Room TTL is three hours, but finished results persist until expiry or
  cleanup.

## Before any destructive step

- [ ] Confirm GitHub repo `akcealan/TakeTwoDubbing` contains the intended source
      and a fresh clone passes `npm ci` + `npm run build`.
- [ ] Confirm no active rooms or participants depend on the deployment.
- [ ] Record the Worker name, bindings, migrations (`v1`/`v2`/`v3`), and Static
      Asset list for the retirement log.
- [ ] Decide whether any hosted private media must be downloaded by its owner
      before deletion. There is no public media; every fetch requires an
      authorized room/scene session.

## Shutdown verification (read-only)

- [ ] Check the Worker responds (or already stopped) at the historical URL.
- [ ] Review current Cloudflare dashboard for the Worker, Durable Object
      classes, and Static Assets.
- [ ] Review current Cloudflare Durable Object class lifecycle and migration
      documentation. Do not assume `wrangler delete` permanently removes all DO
      data on its own.

## Irreversible steps (explicit approval required)

> Each step below is irreversible. Execute only after written user approval.

- [ ] APPROVAL: delete/shut down Worker `take-two-rooms`.
- [ ] Verify the Worker URL no longer serves the app.
- [ ] Separately verify permanent removal of `ROOMS`, `SCENE_STUDIO`, and
      `MEDIA_STORE` data against current Cloudflare documentation and dashboard
      state. If class-level data or migrations survive Worker deletion, follow
      the documented class/migration deletion path and re-verify.
- [ ] Verify Static Assets are removed.
- [ ] Record completion date in `docs/ARCHIVAL.md` (follow-up change).

## After shutdown

- [ ] Keep the local `TakeTwo` directory until backup verification completes;
      final local deletion is a separate approved step.
- [ ] Do not reuse room codes, tokens, or private URLs after deletion.
