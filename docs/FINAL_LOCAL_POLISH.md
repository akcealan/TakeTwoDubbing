# Final local product polish

The normal scene library is private-scene only. The built-in catalog remains an internal
development/test fixture and can still resolve direct fixture routes and room-domain tests, but it
is not merged into `useSceneCatalog` or advertised by normal navigation. An empty private library
shows a Turkish Scene Studio call to action.

## Private thumbnail contract

Scene Studio extracts a deterministic frame in Chromium from the already-authorized source Blob.
The frame is selected at 15% of duration, with a one-second minimum for normal clips and a bounded
end guard for short clips. Canvas output preserves aspect ratio, never upscales, and fits within
640×640. Encoding prefers WebP quality 0.80 and falls back to JPEG quality 0.82. Output is limited
to 512 KiB.

`POST /api/private-scenes/{sceneId}/thumbnail` requires the existing bearer Studio capability.
The Worker accepts only WebP/JPEG, validates the actual container signature and encoded dimensions,
bounds dimensions/timestamp/bytes, generates the UUID and stores bytes as a scene-scoped MediaStore asset.
Only metadata is stored in the Scene Studio Durable Object. Replacement writes the new object,
commits metadata, then best-effort deletes the old object. A failed upload leaves the old scene and
thumbnail intact. Scene deletion removes the thumbnail along with source/background media.

`GET /api/private-scenes/{sceneId}/thumbnail` uses the same owner capability and maps the stored
metadata to its private key; clients never submit or receive object keys. The response uses the
stored MIME, `nosniff`, and a short private cache header. Cards fetch the image with the capability
and render a local object URL, since a native `<img>` cannot attach the bearer header. Missing legacy
metadata or fetch failure keeps the neutral poster.

Thumbnail URLs are not copied into room snapshots and thumbnail objects are not copied under room
prefixes. They are presentation assets only and never enter rendering.

Every source upload creates a new private scene in the current Studio workflow, so it generates a
new associated thumbnail. Saving an older scene without thumbnail metadata attempts local extraction
once; extraction/upload failure does not block the canonical scene save. Ordinary metadata saves
retain existing thumbnail metadata and bytes.
