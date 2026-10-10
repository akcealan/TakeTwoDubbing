from __future__ import annotations

import argparse
import json
import random
import shutil
import time
from pathlib import Path
from uuid import uuid4

import numpy as np
import torch
from demucs_infer.apply import apply_model
from demucs_infer.states import load_model

from take_two_ai.separation import (
    _MemorySampler,
    _peak,
    _relative_l2,
    _rms,
    _signal_metrics,
    decode_stereo_audio,
    write_float_wav,
)

MODEL_NAME = "CDX23 DnR single checkpoint B"
CHECKPOINT_FILENAME = "97d170e1-dbb4db15.th"
CHECKPOINT_SHA256 = "dbb4db154df7e45a5cb72d1659c48937e757f6d6b0eef8ca4199e6e38f8d8f37"
SAMPLE_RATE = 44_100
SHIFTS = 1
OVERLAP = 0.8


def _private_path(path: Path, private_root: Path, label: str) -> Path:
    resolved = path.resolve()
    root = private_root.resolve()
    if resolved != root and not resolved.is_relative_to(root):
        raise ValueError(f"{label} path must stay under {root}")
    return resolved


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate the one allowed CDX23 fallback")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--private-root", type=Path, default=Path("local-test-media"))
    parser.add_argument("--checkpoint-dir", type=Path, default=Path("ai/.cache/models/cdx23"))
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    args = parser.parse_args()

    source = _private_path(args.source, args.private_root, "source")
    output = _private_path(args.output, args.private_root, "output")
    if output.exists():
        raise FileExistsError(f"Evaluation output already exists: {output}")
    checkpoint = args.checkpoint_dir.resolve() / CHECKPOINT_FILENAME
    if not checkpoint.is_file():
        raise FileNotFoundError(f"CDX23 checkpoint missing: {checkpoint}")
    actual_sha256 = _sha256(checkpoint)
    if actual_sha256 != CHECKPOINT_SHA256:
        raise RuntimeError(f"CDX23 checkpoint checksum mismatch: {actual_sha256}")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")

    started = time.perf_counter()
    memory = _MemorySampler()
    memory.start()
    print("[prepare] decoding 44.1 kHz stereo reference", flush=True)
    prepared = decode_stereo_audio(source, sample_rate=SAMPLE_RATE)

    print(f"[load] {MODEL_NAME} on {args.device}", flush=True)
    load_started = time.perf_counter()
    model = load_model(checkpoint)
    load_seconds = time.perf_counter() - load_started
    if list(model.sources) != ["music", "sfx", "speech"]:
        raise RuntimeError(f"Unexpected CDX23 sources: {model.sources}")
    if model.samplerate != SAMPLE_RATE or model.audio_channels != 2:
        raise RuntimeError("Unexpected CDX23 sample rate or channel count")

    callback_starts = 0

    def callback(event: dict[str, object]) -> None:
        nonlocal callback_starts
        if event["state"] == "start":
            callback_starts += 1
            offset = int(event["segment_offset"])
            total = int(event["audio_length"])
            print(f"[infer] segment {callback_starts}, offset {offset}/{total}", flush=True)

    if args.device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    random.seed(0)
    mixture = torch.from_numpy(prepared.samples).unsqueeze(0)
    print("[infer] starting producer-reference separation settings", flush=True)
    inference_started = time.perf_counter()
    separated = apply_model(
        model,
        mixture,
        shifts=SHIFTS,
        split=True,
        overlap=OVERLAP,
        device=args.device,
        num_workers=0,
        callback=callback,
        callback_arg={"audio_length": prepared.sample_count},
    )[0].cpu()
    if args.device == "cuda":
        torch.cuda.synchronize()
    inference_seconds = time.perf_counter() - inference_started

    stems = {
        name: np.ascontiguousarray(separated[index].numpy(), dtype=np.float32)
        for index, name in enumerate(("music", "effects", "speech"))
    }
    expected_shape = prepared.samples.shape
    if any(
        value.shape != expected_shape or not np.isfinite(value).all() for value in stems.values()
    ):
        raise RuntimeError("CDX23 returned malformed stems")
    background = np.asarray(stems["music"] + stems["effects"], dtype=np.float32)
    reconstructed = np.asarray(background + stems["speech"], dtype=np.float32)
    residual = prepared.samples - reconstructed

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.parent / f".{output.name}.{uuid4().hex}.partial"
    audio_outputs = {
        "original-reference.wav": prepared.samples,
        "speech.wav": stems["speech"],
        "music.wav": stems["music"],
        "effects.wav": stems["effects"],
        "background-music-plus-effects.wav": background,
    }
    try:
        staging.mkdir()
        for name, audio in audio_outputs.items():
            print(f"[write] {name}", flush=True)
            write_float_wav(staging / name, audio, SAMPLE_RATE)
        staging.rename(output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        memory.stop()

    signal_metrics = {
        name: {"peak": metric.peak, "rms": metric.rms}
        for name, metric in {
            "original": _signal_metrics(prepared.samples),
            "speech": _signal_metrics(stems["speech"]),
            "music": _signal_metrics(stems["music"]),
            "effects": _signal_metrics(stems["effects"]),
            "backgroundMusicPlusEffects": _signal_metrics(background),
        }.items()
    }
    total_seconds = time.perf_counter() - started
    diagnostics = {
        "model": MODEL_NAME,
        "checkpoint": CHECKPOINT_FILENAME,
        "checkpoint_sha256": actual_sha256,
        "code_license": "MIT",
        "weight_license": "not stated by upstream release",
        "device_used": args.device,
        "torch_version": torch.__version__,
        "torch_cuda_runtime": torch.version.cuda,
        "sample_rate": SAMPLE_RATE,
        "channels": prepared.channels,
        "sample_count": prepared.sample_count,
        "duration_seconds": prepared.duration_seconds,
        "shifts": SHIFTS,
        "overlap": OVERLAP,
        "model_segment_seconds": float(model.segment),
        "forward_segment_count": callback_starts,
        "random_seed": 0,
        "model_load_seconds": load_seconds,
        "inference_seconds": inference_seconds,
        "total_seconds": total_seconds,
        "realtime_factor": inference_seconds / prepared.duration_seconds,
        "peak_vram_allocated_bytes": (
            int(torch.cuda.max_memory_allocated()) if args.device == "cuda" else None
        ),
        "peak_vram_reserved_bytes": (
            int(torch.cuda.max_memory_reserved()) if args.device == "cuda" else None
        ),
        "peak_process_ram_bytes": memory.peak_bytes,
        "signals": signal_metrics,
        "reconstruction": {
            "residual_peak": _peak(residual),
            "residual_rms": _rms(residual),
            "relative_l2": _relative_l2(residual, prepared.samples),
        },
        "output_sizes": {name: (output / name).stat().st_size for name in audio_outputs},
        "warnings": [
            "No objective ground-truth stems exist for this private clip; leakage and artifacts require listening.",
            "The upstream release does not state a separate license for the checkpoint weights.",
        ],
    }
    (output / "diagnostics.json").write_text(
        json.dumps(diagnostics, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(diagnostics, indent=2, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
