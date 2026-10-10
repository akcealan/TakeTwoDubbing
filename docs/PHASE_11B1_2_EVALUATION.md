# Phase 11B1.2 evaluation

This phase targets scene-wide acoustic speaker identity only. It does not identify real
people, use faces, use transcript semantics, change Whisper, or perform Dialogue/Music/SFX
separation. The user screenshots were treated only as evidence that manual correction
substantially changes color/identity grouping while useful timing remains. They are not
acoustic ground truth and the original film clips are not claimed fixed.

## Measured cause

Local source inspection used pyannote.audio 4.0.7 and the cached Community-1 configuration.
Community-1 uses overlap-excluding embeddings and VBx clustering with threshold 0.6. Its
result contains regular and exclusive diarization plus one 256-dimensional centroid per
final speaker. `num_speakers` overrides `min_speakers` and `max_speakers` as the requested
cluster count, although too few usable embeddings can still produce fewer clusters.

The failure is a combination:

- Community-1 can under-count, fragment one voice, or contaminate one final cluster even
  on clean generated profiles.
- Very short detected regions can be too weak for a stable speaker embedding.
- The application previously discarded every embedding and accepted each final pyannote
  label as immutable, so it had no scene-level validation/reassignment pass.

## Stabilization

The implementation preserves raw pyannote as the baseline, extracts bounded turn-level
embeddings with Community-1's already loaded local model, masks overlap, selects clean
long turns as weighted anchors, builds deterministic scene partitions and evaluates them
with a duration-weighted acoustic separation objective. Overlapping simultaneous labels
are cannot-link pairs. Automatic mode evaluates a bounded count neighborhood; exact mode
uses the same code with a fixed count. A candidate is applied only when its objective gain
crosses a centralized threshold. Short turns move to a strong prototype only with both a
minimum similarity and margin. Ambiguous turns keep the best available grouping and get a
review warning. Failure returns the raw diarization with a truthful warning.

Raw identity boundaries remain segmentation boundaries even when two regions receive one
stable identity. This prevents identity merging from silently joining dialogue lines that
Phase 11B1.1 already separated.

## Real local CPU evaluation

The smoke suite used Microsoft Zira-generated, locally pitch-profiled, fully authorized
English WAVs. This is controlled model evidence, not a universal benchmark and not the
user's unavailable film media. Metrics are utterance-turn proxies after optimal label
permutation. The final JSON is written under ignored `test-results/phase11b12/`.

| Scene / mode                            | Raw count | Stable count | Raw accuracy | Stable accuracy | Fragmentation raw/stable | Contamination raw/stable | Short correct |
| --------------------------------------- | --------: | -----------: | -----------: | --------------: | -----------------------: | -----------------------: | ------------: |
| 21.64 s, 2-speaker return, automatic    |         2 |            2 |         100% |            100% |                    0 / 0 |                    0 / 0 |           n/a |
| 21.64 s, 2-speaker return, exact 2      |         2 |            2 |         100% |            100% |                    0 / 0 |                    0 / 0 |           n/a |
| 19.22 s, short third speaker, automatic |         2 |            3 |        83.3% |            100% |                    0 / 0 |                    1 / 0 |         1 / 1 |
| 19.22 s, short third speaker, exact 3   |         3 |            3 |        83.3% |            100% |                    1 / 0 |                    1 / 0 |         1 / 1 |
| 23.09 s, 3-speaker return, automatic    |         2 |            3 |        71.4% |           85.7% |                    0 / 1 |                    1 / 1 |         0 / 1 |
| 23.09 s, 3-speaker return, exact 3      |         3 |            3 |        71.4% |           85.7% |                    1 / 1 |                    1 / 1 |         0 / 1 |

The 23.09 s short sample did not produce a trustworthy match to its same-profile long
anchor; the system did not invent confidence. This is the remaining error behind 85.7%.
The already-correct two-speaker baseline was retained because its candidate gain was below
the acceptance threshold. Additional embedding-pass cost was 312-391 ms on CPU (about
355 ms mean). One full faster-whisper + diarization job completed in 18.93 s and added
332 ms for identity embeddings.

## Limits

Speaker labels are arbitrary. A stable person called `SPEAKER_03` is correct; one acoustic
identity split across several labels is not. Very short phonemes, overlap-dominated turns,
strongly similar voices, voice disguise, reverberation, and media with music/SFX can remain
ambiguous. Manual Scene Studio reassignment remains the authority. Phase 11B2 is separate:
local Dialogue/Music/SFX separation and prepared background-audio generation.
