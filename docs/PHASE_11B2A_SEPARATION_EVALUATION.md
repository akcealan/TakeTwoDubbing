# Phase 11B2A — Real-clip separation engine validation

## Checkpoint boundary

This work validates a local cinematic three-stem engine before product integration.
No separated file is uploaded, no Scene/PreparationDraft/room snapshot schema changes,
and no browser render mixing changes are part of this checkpoint. Private media and all
evaluation WAVs stay below ignored `local-test-media/`.

## Candidate decision

Primary candidate: Bandit v2 Multi. It is purpose-built for cinematic `speech`, `music`,
and `effects` separation, including multilingual DnR v3 training. The selected adapter is
the inference-only `bandit-infer` package pinned to commit
`d45cdec634bf1ee01cdd2acea74a2d100e639c8a`. It carries no weights, training loop,
Lightning, Hydra, dataset, or experiment surface. Its v2 Multi graph is parity-tested
against the untouched upstream implementation.

Secondary candidate: CDX23 Demucs. Its official implementation produces the same three
semantic stems and is MIT licensed, but the release does not state a separate weight
license. Bandit's sole official model host repeatedly returned HTTP 504, so the allowed
fallback condition was met. Exactly one fallback was evaluated: the producer's normal
single-model checkpoint B. No additional model family or checkpoint was tried.

Generic music vocal-removal models were rejected as the main path because vocals versus
accompaniment is not the product's dialogue/music/effects taxonomy.

## Provenance and licensing

| Item                    | Source                                            | License/integrity                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bandit v2 code          | `kwatcharasupat/bandit-v2`                        | Apache-2.0                                                                                                                                                                          |
| Bandit v2 Multi weights | Zenodo record `12701995`, `checkpoint-multi.ckpt` | CC-BY-SA-4.0; 446,680,129 bytes; upstream MD5 `fea2868787551b0cff36cfcf7c3622a3`; independently recorded SHA-256 `abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc` |
| `bandit-infer` adapter  | `openmirlab/bandit-infer` at `d45cdec…`           | Apache-2.0; inference-only; not yet published on PyPI                                                                                                                               |
| CDX23 code              | `ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing`    | MIT                                                                                                                                                                                 |
| CDX23 checkpoint B      | GitHub release `v.1.0.0`, `97d170e1-dbb4db15.th`  | 53,916,935 bytes; full SHA-256 `dbb4db154df7e45a5cb72d1659c48937e757f6d6b0eef8ca4199e6e38f8d8f37`; separate weight license not stated                                               |

Weights remain a local cache download and are never committed, converted, or rehosted.

## Local execution contract

- Native model input/output: 48 kHz stereo float32, `(channels, samples)`.
- Upstream inner handler: 8 s chunks, 1 s hop, Hann overlap-add, batch size 1.
- Take Two outer bound: 24 s windows with 2 s cosine overlap, moved back to CPU per call.
- Listening outputs: lossless 32-bit IEEE-float WAV with no independent stem normalization.
- Background semantics: exactly `music + effects`; speech is never intentionally mixed in.
- Reconstruction diagnostic: `speech + music + effects` compared with the decoded mixture.
- Cancellation: before/after each outer inference call and during output stages. One active
  model call is not force-killed because no subprocess or safe per-forward interrupt exists.
- Device truth: explicit CUDA must exist; auto chooses CUDA only when Torch reports it.
  CUDA OOM is recorded and may restart the complete operation on CPU.

## Machine characterization

- GPU: NVIDIA GeForce RTX 3050 Laptop GPU, 4 GiB.
- Driver: 616.64; driver-reported CUDA UMD 13.4.
- Isolated CUDA runtime: Torch 2.11.0+cu128; CUDA availability `true`.
- CUDA memory reported immediately after setup: 3,466,277,684 bytes free of
  4,294,443,008 bytes visible to Torch.
- Existing Phase 11B1 environment remains Torch 2.14.0+cpu and was not upgraded.

## Real-clip result

Source: ignored private `local-test-media/clip1-speaker-regression.mp4`, decoded to
1,857,536 stereo samples at 44.1 kHz (42.120998 s). The CDX23 B run follows the producer
reference settings: one time shift, 0.8 overlap, 8.68 s model segments and deterministic
random seed 0. It performs 25 model-segment forward calls.

| Measurement         |            CUDA |             CPU |
| ------------------- | --------------: | --------------: |
| Torch               |    2.11.0+cu128 |      2.14.0+cpu |
| Model load          |         0.174 s |         0.190 s |
| Inference           |         6.436 s |        60.009 s |
| Real-time factor    |           0.153 |           1.425 |
| Peak process RAM    | 1,464,942,592 B | 1,144,655,872 B |
| Peak allocated VRAM |   466,517,504 B |             n/a |
| Peak reserved VRAM  |   597,688,320 B |             n/a |

CUDA is the recommended device on this machine: it was about 9.3 times faster by measured
inference time and stayed well below the 4 GiB VRAM ceiling. CPU remains a verified explicit
path, not an inferred or silent fallback. The two device outputs are numerically close but
not bit-identical; maximum per-sample differences were 0.000379 speech, 0.000238 music,
0.000707 effects and 0.000611 background.

Each listening WAV is IEEE 32-bit float stereo, 44.1 kHz, 1,857,536 samples, 42.120998 s
and 14,860,380 bytes. No stem was independently normalized. The CUDA listening handoff is:

- `local-test-media/separation-eval/clip1-speaker-regression-cdx23/original-reference.wav`
- `local-test-media/separation-eval/clip1-speaker-regression-cdx23/speech.wav`
- `local-test-media/separation-eval/clip1-speaker-regression-cdx23/music.wav`
- `local-test-media/separation-eval/clip1-speaker-regression-cdx23/effects.wav`
- `local-test-media/separation-eval/clip1-speaker-regression-cdx23/background-music-plus-effects.wav`
- `local-test-media/separation-eval/clip1-speaker-regression-cdx23/diagnostics.json`

`background-music-plus-effects.wav` equals the decoded `music.wav + effects.wav` exactly
(maximum error 0.0). Stem-sum reconstruction against the reference has residual peak
0.259595, residual RMS 0.002456 and relative L2 0.021279. These are integrity diagnostics,
not perceptual quality scores. Segment-boundary sample deltas were below each output's
global 99.9th-percentile delta, providing no automated sign of boundary clicks.

There is no ground-truth stem set for this clip. Automated analysis therefore cannot
honestly certify dialogue leakage/attenuation, music-versus-SFX assignment, musical
warbling, transient smearing or behavior on other genres/languages. The speech-heavy
signal energy distribution (RMS speech 0.10976, music 0.00519, effects 0.03205) also makes
subjective listening essential. CDX23 B is the provisional listening candidate only; its
unstated weight license prevents a clean permanent recommendation. Bandit v2 Multi remains
the preferred next checkpoint if its official Zenodo artifact becomes available, but no
Scene Studio/R2/renderer integration may proceed before explicit user approval.

## Verification to date

- Final normal Python suite: 47 passed, 2 opt-in tests skipped.
- New separation coverage includes stereo preparation, float WAV round-trip, outer chunk
  boundary stitching, duration preservation, exact background semantics, cancellation,
  device selection, CUDA OOM restart, malformed stems, missing package, and path isolation.
- Phase 11B1.3 real private-clip regression passed again (1 passed) in the untouched main
  AI environment; only its already-known short-input `std()` warning appeared.
- CUDA and CPU CDX23 real-clip runs completed; five-file format/duration checks, exact
  background semantics, reconstruction diagnostics and boundary analysis passed.
- TypeScript/frontend/Worker code was not changed, so browser/render suites are out of
  scope.

State: **PHASE 11B2A COMPLETE — WAITING FOR USER LISTENING APPROVAL**
