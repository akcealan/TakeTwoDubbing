# Cloudflare shutdown checklist (completed 2026-10-10)

This checklist recorded the safe retirement of the historical production
deployment. All steps below are complete. The historical architecture
documentation in `docs/` is preserved unchanged.

## Final state

- Worker `take-two-rooms` is **deleted**. Authenticated CLI checks return
  Worker-not-found (code 10007); the former public URL
  `https://take-two-rooms.take-two.workers.dev` returns HTTP 404.
- Durable Object classes `GameRoom`, `SceneStudio`, and `MediaStore` were
  permanently removed with all stored data via a `v4` legacy `deleted_classes`
  migration before Worker deletion. The dashboard independently showed
  "No Durable Objects found".
- R2 was never provisioned (bucket list: code 10042). No Worker secrets existed.
- No hosted scenes, recordings, final MP4s, or private media were preserved,
  per explicit decision. No backup was requested.

## Completed verification (2026-10-10)

- [x] GitHub repo `akcealan/TakeTwoDubbing` contained the intended source;
      a fresh clone passed `npm ci` + `npm run build`.
- [x] No active rooms or participants depended on the deployment
      (retirement explicitly authorized with no preservation requirement).
- [x] Worker name, bindings (`ROOMS`, `SCENE_STUDIO`, `MEDIA_STORE`, `ASSETS`),
      migrations (`v1`/`v2`/`v3`), and Static Asset list recorded in prior
      retirement reports before any destructive step.
- [x] Phase A migration deploy accepted and applied; live version showed zero
      bindings and all application endpoints returned HTTP 410.
- [x] Phase B `wrangler delete --name take-two-rooms` succeeded;
      post-delete URL check returned HTTP 404.
- [x] No unrelated Cloudflare resources were modified (R2 never enabled,
      no other Workers touched).

## After shutdown

- [ ] Keep the local `TakeTwo` directory until backup verification completes;
      final local deletion is a separate approved step.
- [ ] Do not reuse room codes, tokens, or private URLs after deletion.
