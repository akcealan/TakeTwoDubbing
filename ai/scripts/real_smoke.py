from __future__ import annotations

import argparse
import json
import os
import threading
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

from take_two_ai.config import Settings
from take_two_ai.models import LocalModelEngine


def concatenate_wavs(
    parts: list[Path], destination: Path, silence_ms: int, speed_factors: list[float]
) -> int:
    parameters = None
    frames: list[bytes] = []
    for index, part in enumerate(parts):
        with wave.open(str(part), "rb") as source:
            current = (
                source.getnchannels(),
                source.getsampwidth(),
                source.getframerate(),
            )
            if parameters is None:
                parameters = current
            if current != parameters:
                raise ValueError("All WAV parts must use the same channel, width and sample rate.")
            raw = source.readframes(source.getnframes())
            factor = speed_factors[index]
            if factor == 1:
                frames.append(raw)
            else:
                samples = np.frombuffer(raw, dtype=np.int16)
                adjusted = resample_poly(samples.astype(np.float32), 100, round(100 * factor))
                frames.append(np.clip(adjusted, -32768, 32767).astype(np.int16).tobytes())
            if index < len(parts) - 1:
                silence_frames = round(source.getframerate() * silence_ms / 1000)
                frames.append(bytes(silence_frames * source.getnchannels() * source.getsampwidth()))
    if parameters is None:
        raise ValueError("At least one WAV part is required.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(destination), "wb") as output:
        output.setnchannels(parameters[0])
        output.setsampwidth(parameters[1])
        output.setframerate(parameters[2])
        output.writeframes(b"".join(frames))
    with wave.open(str(destination), "rb") as source:
        return round(source.getnframes() / source.getframerate() * 1000)


def run_once(engine: LocalModelEngine, source: Path, duration_ms: int, expected: int | None):
    stages: list[str] = []
    result = engine.run(
        source,
        duration_ms,
        lambda stage: (stages.append(stage), print(f"[{expected or 'auto'}] {stage}")),
        threading.Event(),
        expected,
    )
    diagnostic = max(
        (engine.settings.cache_dir / "diagnostics").glob("analysis-*.json"),
        key=lambda path: path.stat().st_mtime_ns,
    )
    trace = json.loads(diagnostic.read_text(encoding="utf-8"))
    segment_speakers: dict[int, set[str]] = {}
    for word in trace["wordAssignments"]:
        segment_speakers.setdefault(word["segmentIndex"], set()).add(word["speakerId"])
    return {
        "mode": expected or "automatic",
        "rawSpeakerLabels": trace["rawUniqueSpeakerLabels"],
        "draftSpeakerCount": len(result.characters),
        "draftLineCount": len(result.lines),
        "speakerChangesInsideWhisperSegment": any(
            len(speakers - {"SPEAKER_UNKNOWN"}) > 1 for speakers in segment_speakers.values()
        ),
        "diagnostic": str(diagnostic),
        "lines": [line.model_dump(by_alias=True) for line in result.lines],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run real local models on owned WAV parts.")
    parser.add_argument("parts", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected", type=int, default=3)
    parser.add_argument("--silence-ms", type=int, default=450)
    parser.add_argument("--speed-factors", type=float, nargs="+")
    args = parser.parse_args()
    speed_factors = args.speed_factors or [1.0] * len(args.parts)
    if len(speed_factors) != len(args.parts):
        parser.error("--speed-factors must contain one value for each WAV part")
    duration_ms = concatenate_wavs(args.parts, args.output, args.silence_ms, speed_factors)
    os.environ["TAKETWO_AI_DIAGNOSTICS"] = "1"
    engine = LocalModelEngine(Settings())
    summaries = [
        run_once(engine, args.output, duration_ms, None),
        run_once(engine, args.output, duration_ms, args.expected),
    ]
    print(json.dumps({"durationMs": duration_ms, "runs": summaries}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
