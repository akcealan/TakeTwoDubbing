from __future__ import annotations

import argparse
import json
import os
import threading
import time
import wave
from pathlib import Path
from typing import Any

from take_two_ai.config import Settings
from take_two_ai.domain import DiarizationTurn
from take_two_ai.media import extract_mono_wav
from take_two_ai.models import LocalModelEngine
from take_two_ai.speaker_evaluation import permutation_invariant_turn_metrics


def concatenate_scene(scene: dict[str, Any], output: Path) -> tuple[int, list[dict[str, Any]]]:
    silence_ms = int(scene.get("silenceMs", 450))
    raw_output = output.with_suffix(".source.wav")
    reference: list[dict[str, Any]] = []
    format_parameters: tuple[int, int, int] | None = None
    chunks: list[bytes] = []
    current_ms = 0
    for index, part in enumerate(scene["parts"]):
        path = Path(part["path"])
        with wave.open(str(path), "rb") as source:
            parameters = (
                source.getnchannels(),
                source.getsampwidth(),
                source.getframerate(),
            )
            if format_parameters is None:
                format_parameters = parameters
            if parameters != format_parameters:
                raise ValueError(f"WAV format mismatch in {path}")
            frames = source.readframes(source.getnframes())
            duration_ms = round(source.getnframes() / source.getframerate() * 1000)
            chunks.append(frames)
            reference.append(
                {
                    "startMs": current_ms,
                    "endMs": current_ms + duration_ms,
                    "speakerId": str(part["speaker"]),
                    "short": bool(part.get("short", False)),
                }
            )
            current_ms += duration_ms
            if index < len(scene["parts"]) - 1:
                chunks.append(
                    bytes(
                        round(source.getframerate() * silence_ms / 1000)
                        * source.getnchannels()
                        * source.getsampwidth()
                    )
                )
                current_ms += silence_ms
    if format_parameters is None:
        raise ValueError("A scene must contain at least one WAV part.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(raw_output), "wb") as destination:
        destination.setnchannels(format_parameters[0])
        destination.setsampwidth(format_parameters[1])
        destination.setframerate(format_parameters[2])
        destination.writeframes(b"".join(chunks))
    extract_mono_wav(raw_output, output)
    raw_output.unlink(missing_ok=True)
    with wave.open(str(output), "rb") as source:
        duration_ms = round(source.getnframes() / source.getframerate() * 1000)
    return duration_ms, reference


def label_reference_turns(
    reference: list[dict[str, Any]], turns: list[DiarizationTurn]
) -> list[str]:
    labels: list[str] = []
    for region in reference:
        scores: dict[str, int] = {}
        for turn in turns:
            overlap = max(
                0,
                min(region["endMs"], turn.end_ms) - max(region["startMs"], turn.start_ms),
            )
            scores[turn.speaker_id] = scores.get(turn.speaker_id, 0) + overlap
        labels.append(
            min(scores, key=lambda label: (-scores[label], label))
            if scores and max(scores.values()) > 0
            else "MISSED_SPEECH"
        )
    return labels


def run_mode(
    engine: LocalModelEngine,
    source: Path,
    duration_ms: int,
    reference: list[dict[str, Any]],
    expected: int | None,
) -> dict[str, Any]:
    started = time.perf_counter()
    stabilized, diagnostics = engine._diarize(
        source,
        expected,
        threading.Event(),
        include_vectors=True,
    )
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    raw = [
        DiarizationTurn(item["startMs"], item["endMs"], item["speakerId"])
        for item in diagnostics["rawDiarizationTurns"]
    ]
    truth = [item["speakerId"] for item in reference]
    raw_labels = label_reference_turns(reference, raw)
    final_labels = label_reference_turns(reference, stabilized)
    raw_metrics = permutation_invariant_turn_metrics(truth, raw_labels)
    final_metrics = permutation_invariant_turn_metrics(truth, final_labels)
    mapping = final_metrics["optimalLabelMapping"]
    short_indices = [index for index, item in enumerate(reference) if item["short"]]
    short_correct = sum(
        1 for index in short_indices if mapping.get(final_labels[index]) == truth[index]
    )
    stabilization = diagnostics["sceneSpeakerStabilization"]
    return {
        "mode": expected or "automatic",
        "suppliedSpeakerCount": expected,
        "elapsedMs": elapsed_ms,
        "additionalEmbeddingPassMs": stabilization.get("additionalEmbeddingPassMs"),
        "stabilizationStatus": stabilization.get("status"),
        "objectiveGain": stabilization.get("objectiveGain"),
        "raw": raw_metrics,
        "stabilized": final_metrics,
        "shortTurnCount": len(short_indices),
        "shortTurnsCorrect": short_correct,
        "referenceLabels": truth,
        "rawLabels": raw_labels,
        "stabilizedLabels": final_labels,
        "diagnostics": diagnostics,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate raw Community-1 and stabilized scene identities on owned WAVs."
    )
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    os.environ["TAKETWO_AI_DIAGNOSTICS"] = "0"
    engine = LocalModelEngine(Settings())
    summaries: list[dict[str, Any]] = []
    for scene in manifest["scenes"]:
        source = args.output_dir / f"{scene['name']}.mono.wav"
        duration_ms, reference = concatenate_scene(scene, source)
        runs = [run_mode(engine, source, duration_ms, reference, None)]
        exact = scene.get("exactSpeakerCount")
        if exact is not None:
            runs.append(run_mode(engine, source, duration_ms, reference, int(exact)))
        summaries.append(
            {
                "name": scene["name"],
                "durationMs": duration_ms,
                "reference": reference,
                "runs": runs,
            }
        )
    result = {"schemaVersion": 1, "scenes": summaries}
    destination = args.output_dir / "speaker-evaluation.json"
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    concise = {
        "output": str(destination),
        "scenes": [
            {
                "name": scene["name"],
                "durationMs": scene["durationMs"],
                "runs": [
                    {
                        key: run[key]
                        for key in (
                            "mode",
                            "elapsedMs",
                            "additionalEmbeddingPassMs",
                            "stabilizationStatus",
                            "objectiveGain",
                            "raw",
                            "stabilized",
                            "shortTurnCount",
                            "shortTurnsCorrect",
                        )
                    }
                    for run in scene["runs"]
                ],
            }
            for scene in summaries
        ],
    }
    print(json.dumps(concise, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
