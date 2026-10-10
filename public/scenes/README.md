# Original development scenes

The SVG posters and dialogue scripts were created for Take Two during Phase 1.
No third-party movie, television, game, or dublaj.io assets are included.

`a-small-step/video.webm` is an original, silent 30-second development animation
generated locally for Take Two in Phase 4. It uses only procedural canvas artwork
and project typography/colors; it contains no third-party footage or audio.

`the-last-table` still reserves a video URL that does **not** exist.
`mediaStatus: 'placeholder'` keeps that unavailable state explicit; clients must
not request the missing asset or pretend playback works.

Before a scene can be playable, add an owned or appropriately licensed video at
the declared path, verify its duration against the millisecond timeline, then
change `mediaStatus` to `available`. Document external licensing here if used.
Background audio is optional and should contain no original dialogue.
