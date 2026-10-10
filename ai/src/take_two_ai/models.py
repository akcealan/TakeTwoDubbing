from __future__ import annotations

import json
import os
import threading
import time
import wave
from collections.abc import Callable
from pathlib import Path

import numpy as np

from .config import Settings, configure_private_caches
from .domain import DiarizationTurn, Transcript, TranscriptSegment, Word, merge_to_draft
from .media import extract_mono_wav
from .schemas import EditableDraft, JobStage
from .speaker_stabilization import (
    MIN_EMBEDDING_TURN_MS,
    TurnAcousticEvidence,
    stabilize_scene_speakers,
)

MAX_TURN_EMBEDDING_MS = 12_000


class CancelledError(RuntimeError):
    pass


class LocalModelEngine:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._whisper = None
        self._diarization = None

    def run(
        self,
        source: Path,
        duration_ms: int,
        progress: Callable[[JobStage], None],
        cancel: threading.Event,
        expected_speaker_count: int | None = None,
    ) -> EditableDraft:
        configure_private_caches(self.settings, offline=True)
        wav_path = source.with_suffix(".mono.wav")
        progress("preparing_audio")
        extract_mono_wav(source, wav_path)
        diagnostics = self._new_diagnostics(wav_path, duration_ms, expected_speaker_count)
        self._check_cancel(cancel)

        progress("transcribing")
        transcript = self._transcribe(wav_path, cancel)
        if diagnostics is not None:
            diagnostics["detectedLanguage"] = transcript.language
            diagnostics["languageProbability"] = transcript.language_probability
            diagnostics["whisperSegments"] = [
                {
                    "startMs": segment.start_ms,
                    "endMs": segment.end_ms,
                    "text": segment.text,
                    "logProbability": segment.log_probability,
                    "words": [
                        {"startMs": word.start_ms, "endMs": word.end_ms, "text": word.text}
                        for word in segment.words
                    ],
                }
                for segment in transcript.segments
            ]
        self._check_cancel(cancel)

        progress("diarizing")
        turns, raw_diarization = self._diarize(
            wav_path,
            expected_speaker_count,
            cancel,
            include_vectors=diagnostics is not None,
        )
        if diagnostics is not None:
            diagnostics.update(raw_diarization)
        self._check_cancel(cancel)

        progress("merging")
        result = merge_to_draft(
            transcript,
            turns,
            duration_ms,
            transcription_model=self.settings.whisper_model,
            diarization_model=self.settings.diarization_model,
            device=self.settings.device,
            diagnostics=diagnostics,
        )
        if diagnostics is not None:
            self._write_diagnostics(diagnostics)
        progress("building_draft")
        return result

    def _transcribe(self, wav_path: Path, cancel: threading.Event) -> Transcript:
        if self._whisper is None:
            self._prepare_windows_dlls()
            from faster_whisper import WhisperModel

            compute_type = "int8_float16" if self.settings.device == "cuda" else "int8"
            self._whisper = WhisperModel(
                self.settings.whisper_model,
                device=self.settings.device,
                compute_type=compute_type,
                download_root=str(self.settings.model_cache / "faster-whisper"),
                local_files_only=True,
            )
        segments, info = self._whisper.transcribe(
            str(wav_path), beam_size=5, word_timestamps=True, vad_filter=True
        )
        values: list[TranscriptSegment] = []
        for segment in segments:
            self._check_cancel(cancel)
            words = tuple(
                Word(
                    start_ms=round(word.start * 1000),
                    end_ms=round(word.end * 1000),
                    text=word.word,
                )
                for word in (segment.words or ())
                if word.start is not None and word.end is not None
            )
            values.append(
                TranscriptSegment(
                    start_ms=round(segment.start * 1000),
                    end_ms=round(segment.end * 1000),
                    text=segment.text,
                    words=words,
                    log_probability=getattr(segment, "avg_logprob", None),
                )
            )
        return Transcript(
            segments=tuple(values),
            language=getattr(info, "language", None),
            language_probability=getattr(info, "language_probability", None),
        )

    def _diarize(
        self,
        wav_path: Path,
        expected_speaker_count: int | None = None,
        cancel: threading.Event | None = None,
        *,
        include_vectors: bool = False,
    ) -> tuple[list[DiarizationTurn], dict[str, object]]:
        import torch

        if self._diarization is None:
            from pyannote.audio import Pipeline

            self._diarization = Pipeline.from_pretrained(
                self.settings.diarization_model,
                token=os.getenv("HF_TOKEN") or None,
                cache_dir=str(self.settings.model_cache / "pyannote"),
            )
            if self.settings.device == "cuda":
                self._diarization.to(torch.device("cuda"))
        with wave.open(str(wav_path), "rb") as source:
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16)
            sample_rate = source.getframerate()
            waveform = torch.from_numpy(samples.astype(np.float32) / 32768.0).unsqueeze(0)
        return apply_pyannote_pipeline(
            self._diarization,
            {"waveform": waveform, "sample_rate": sample_rate},
            expected_speaker_count,
            cancel=cancel,
            include_vectors=include_vectors,
        )

    def _new_diagnostics(
        self, wav_path: Path, duration_ms: int, expected_speaker_count: int | None
    ) -> dict[str, object] | None:
        if not _diagnostics_directory(self.settings):
            return None
        with wave.open(str(wav_path), "rb") as source:
            pcm = {
                "sampleRate": source.getframerate(),
                "channels": source.getnchannels(),
                "sampleWidthBytes": source.getsampwidth(),
                "frameCount": source.getnframes(),
            }
        return {
            "schemaVersion": 1,
            "createdAtUnixMs": round(time.time() * 1000),
            "durationMs": duration_ms,
            "expectedSpeakerCount": expected_speaker_count,
            "pcm": pcm,
        }

    def _write_diagnostics(self, diagnostics: dict[str, object]) -> None:
        directory = _diagnostics_directory(self.settings)
        if directory is None:
            return
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / f"analysis-{diagnostics['createdAtUnixMs']}.json"
        destination.write_text(
            json.dumps(diagnostics, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @staticmethod
    def _check_cancel(cancel: threading.Event) -> None:
        if cancel.is_set():
            raise CancelledError()

    @staticmethod
    def _prepare_windows_dlls() -> None:
        if os.name != "nt" or not hasattr(os, "add_dll_directory"):
            return
        try:
            import torch

            library_dir = Path(torch.__file__).resolve().parent / "lib"
            if library_dir.is_dir():
                os.add_dll_directory(str(library_dir))
        except ImportError:
            pass


def adapt_pyannote_output(output) -> tuple[list[DiarizationTurn], dict[str, object]]:
    """Adapt Community-1 without replacing overlap-preserving diarization by exclusive output."""
    annotation = getattr(output, "speaker_diarization", output)
    turns = diarization_annotation_to_turns(annotation)
    exclusive = getattr(output, "exclusive_speaker_diarization", None)
    exclusive_turns = diarization_annotation_to_turns(exclusive) if exclusive is not None else []
    diagnostics: dict[str, object] = {
        "pyannoteRepresentation": (
            "speaker_diarization" if hasattr(output, "speaker_diarization") else "annotation"
        ),
        "rawDiarizationTurns": [_turn_json(turn) for turn in turns],
        "rawUniqueSpeakerLabels": sorted({turn.speaker_id for turn in turns}),
        "exclusiveDiarizationTurns": [_turn_json(turn) for turn in exclusive_turns],
    }
    centroids = getattr(output, "speaker_embeddings", None)
    labels = list(annotation.labels()) if hasattr(annotation, "labels") else []
    if centroids is not None:
        values = np.asarray(centroids)
        diagnostics["pyannoteSpeakerEmbeddings"] = [
            {
                "speakerId": str(labels[index]) if index < len(labels) else f"CLUSTER_{index:02d}",
                "embedding": [round(float(value), 7) for value in vector],
            }
            for index, vector in enumerate(values)
            if np.all(np.isfinite(vector)) and np.linalg.norm(vector) > 0
        ]
    return turns, diagnostics


def apply_pyannote_pipeline(
    pipeline,
    audio,
    expected_speaker_count: int | None,
    *,
    cancel: threading.Event | None = None,
    include_vectors: bool = False,
):
    parameters = {"num_speakers": expected_speaker_count} if expected_speaker_count else {}
    turns, diagnostics = adapt_pyannote_output(pipeline(audio, **parameters))
    if not turns:
        diagnostics["sceneSpeakerStabilization"] = {
            "status": "baseline_retained",
            "reason": "no_speech_turns",
            "mode": "exact" if expected_speaker_count is not None else "automatic",
        }
        return turns, diagnostics
    try:
        started = time.perf_counter()
        evidence = extract_turn_acoustic_evidence(pipeline, audio, turns, cancel=cancel)
        stabilization = stabilize_scene_speakers(
            turns,
            evidence,
            expected_speaker_count,
            include_vectors=include_vectors,
        )
        stabilization.diagnostics["additionalEmbeddingPassMs"] = round(
            (time.perf_counter() - started) * 1000
        )
        diagnostics["sceneSpeakerStabilization"] = stabilization.diagnostics
        return stabilization.turns, diagnostics
    except CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 -- optional stabilization must preserve baseline
        diagnostics["sceneSpeakerStabilization"] = {
            "status": "baseline_retained",
            "reason": "stabilization_error",
            "errorType": type(error).__name__,
            "mode": "exact" if expected_speaker_count is not None else "automatic",
            "pyannoteSpeakerCount": len({turn.speaker_id for turn in turns}),
            "userConstrainedSpeakerCount": expected_speaker_count,
        }
        return [_failed_stabilization_turn(turn) for turn in turns], diagnostics


def extract_turn_acoustic_evidence(
    pipeline,
    audio,
    turns: list[DiarizationTurn],
    *,
    cancel: threading.Event | None = None,
) -> list[TurnAcousticEvidence]:
    """Embed exact clean turn spans without length-dependent batch padding.

    WeSpeaker's feature normalization happens before its late pooling mask, so padding
    unrelated short and long turns into one tensor changes the short turn's identity
    vector. Each contiguous clean span is therefore embedded independently. Overlap can
    split a turn into several spans; sufficiently long spans are combined only after
    embedding, using clean duration as weight.
    """
    import torch

    embedder = getattr(pipeline, "_embedding", None)
    if embedder is None or not callable(embedder):
        raise RuntimeError(
            "The installed diarization pipeline does not expose its embedding model."
        )
    waveform = audio.get("waveform") if isinstance(audio, dict) else None
    sample_rate = audio.get("sample_rate") if isinstance(audio, dict) else None
    if not isinstance(waveform, torch.Tensor) or not isinstance(sample_rate, int):
        raise TypeError("Turn embedding extraction requires an in-memory waveform and sample rate.")
    if waveform.ndim != 2 or waveform.shape[0] != 1:
        raise ValueError("Turn embedding extraction expects one mono waveform channel.")

    total_samples = waveform.shape[1]
    overlap_intervals = [_overlaps_for_turn(index, turns) for index in range(len(turns))]
    results: list[TurnAcousticEvidence] = []
    vectors: list[np.ndarray | None] = [None] * len(turns)
    clean_values: list[int] = []
    overlap_values: list[int] = []
    extraction_details: list[dict[str, object]] = []

    for index, turn in enumerate(turns):
        duration_ms = max(0, turn.end_ms - turn.start_ms)
        overlap_ms = _union_length(overlap_intervals[index])
        clean_ms = max(0, duration_ms - overlap_ms)
        clean_values.append(clean_ms)
        overlap_values.append(overlap_ms)
        capped_end_ms = min(turn.end_ms, turn.start_ms + MAX_TURN_EMBEDDING_MS)
        start_sample = max(0, min(total_samples, round(turn.start_ms * sample_rate / 1000)))
        end_sample = max(
            start_sample,
            min(total_samples, round(capped_end_ms * sample_rate / 1000)),
        )
        excluded: list[tuple[int, int]] = []
        for overlap_start_ms, overlap_end_ms in overlap_intervals[index]:
            overlap_start_sample = max(
                start_sample,
                min(end_sample, round(overlap_start_ms * sample_rate / 1000)),
            )
            overlap_end_sample = max(
                overlap_start_sample,
                min(end_sample, round(overlap_end_ms * sample_rate / 1000)),
            )
            if overlap_end_sample > overlap_start_sample:
                excluded.append((overlap_start_sample, overlap_end_sample))
        clean_spans = _subtract_sample_intervals(start_sample, end_sample, excluded)
        minimum_samples = round(MIN_EMBEDDING_TURN_MS * sample_rate / 1000)
        usable_spans = [span for span in clean_spans if span[1] - span[0] >= minimum_samples]
        extraction_details.append(
            {
                "start": start_sample,
                "end": end_sample,
                "sourceSamples": max(0, end_sample - start_sample),
                "overlapChanged": clean_spans != [(start_sample, end_sample)],
                "cleanSpans": tuple(clean_spans),
            }
        )
        if clean_ms < MIN_EMBEDDING_TURN_MS or not usable_spans:
            continue
        if cancel is not None and cancel.is_set():
            raise CancelledError()
        span_vectors: list[np.ndarray] = []
        span_weights: list[int] = []
        for span_start, span_end in usable_spans:
            value = waveform[:, span_start:span_end].unsqueeze(0)
            embedded = np.asarray(embedder(value))
            if embedded.ndim != 2 or embedded.shape[0] != 1:
                raise ValueError("Community-1 returned an unexpected turn embedding shape.")
            vector = embedded[0].astype(np.float64, copy=False)
            norm = float(np.linalg.norm(vector))
            if np.all(np.isfinite(vector)) and norm > 0:
                span_vectors.append(vector / norm)
                span_weights.append(span_end - span_start)
        if span_vectors:
            combined = np.average(np.vstack(span_vectors), axis=0, weights=span_weights)
            combined_norm = float(np.linalg.norm(combined))
            if np.all(np.isfinite(combined)) and combined_norm > 0:
                vectors[index] = combined / combined_norm

    for index in range(len(turns)):
        details = extraction_details[index]
        results.append(
            TurnAcousticEvidence(
                embedding=vectors[index],
                clean_ms=clean_values[index],
                overlap_ms=overlap_values[index],
                crop_start_sample=int(details["start"]),
                crop_end_sample=int(details["end"]),
                source_sample_count=int(details["sourceSamples"]),
                artificial_padding_samples=0,
                overlap_masking_changed_crop=bool(details["overlapChanged"]),
                clean_spans=details["cleanSpans"],  # type: ignore[arg-type]
            )
        )
    return results


def _subtract_sample_intervals(
    start: int, end: int, excluded: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    """Return ordered contiguous samples left after bounded overlap removal."""
    if end <= start:
        return []
    spans: list[tuple[int, int]] = []
    cursor = start
    for excluded_start, excluded_end in _merge_intervals(excluded):
        if excluded_start > cursor:
            spans.append((cursor, min(end, excluded_start)))
        cursor = max(cursor, excluded_end)
        if cursor >= end:
            break
    if cursor < end:
        spans.append((cursor, end))
    return [span for span in spans if span[1] > span[0]]


def diarization_annotation_to_turns(annotation) -> list[DiarizationTurn]:
    if annotation is None:
        return []
    turns = [
        DiarizationTurn(
            start_ms=round(turn.start * 1000),
            end_ms=round(turn.end * 1000),
            speaker_id=str(speaker),
        )
        for turn, _, speaker in annotation.itertracks(yield_label=True)
        if turn.end > turn.start
    ]
    return sorted(turns, key=lambda turn: (turn.start_ms, turn.end_ms, turn.speaker_id))


def _turn_json(turn: DiarizationTurn) -> dict[str, object]:
    return {
        "startMs": turn.start_ms,
        "endMs": turn.end_ms,
        "speakerId": turn.speaker_id,
        "confidence": turn.confidence,
        "boundarySpeakerId": turn.boundary_speaker_id,
        "uncertain": turn.uncertain,
        "stabilizationFailed": turn.stabilization_failed,
    }


def _overlaps_for_turn(index: int, turns: list[DiarizationTurn]) -> list[tuple[int, int]]:
    current = turns[index]
    intervals: list[tuple[int, int]] = []
    for other_index, other in enumerate(turns):
        if other_index == index or other.speaker_id == current.speaker_id:
            continue
        start_ms = max(current.start_ms, other.start_ms)
        end_ms = min(current.end_ms, other.end_ms)
        if end_ms > start_ms:
            intervals.append((start_ms, end_ms))
    return _merge_intervals(intervals)


def _merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start_ms, end_ms in sorted(intervals):
        if not merged or start_ms > merged[-1][1]:
            merged.append((start_ms, end_ms))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end_ms))
    return merged


def _union_length(intervals: list[tuple[int, int]]) -> int:
    return sum(end_ms - start_ms for start_ms, end_ms in _merge_intervals(intervals))


def _failed_stabilization_turn(turn: DiarizationTurn) -> DiarizationTurn:
    return DiarizationTurn(
        start_ms=turn.start_ms,
        end_ms=turn.end_ms,
        speaker_id=turn.speaker_id,
        confidence=turn.confidence,
        boundary_speaker_id=turn.boundary_speaker_id or turn.speaker_id,
        uncertain=True,
        stabilization_failed=True,
    )


def _diagnostics_directory(settings: Settings) -> Path | None:
    value = os.getenv("TAKETWO_AI_DIAGNOSTICS", "").strip()
    if value.lower() in {"", "0", "false", "off"}:
        return None
    if value.lower() in {"1", "true", "on"}:
        return settings.cache_dir / "diagnostics"
    return Path(value).resolve()
