from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from .schemas import Analysis, Character, DialogueLine, EditableDraft, LineAnalysis, Warning

# These values live together so timing behavior is reviewable and fixture-tested.
WORD_TURN_TOLERANCE_MS = 140
SPEAKER_JITTER_MARGIN_MS = 70
MEANINGFUL_SPEECH_GAP_MS = 650
MAX_LINE_DURATION_MS = 6_500
MIN_REVIEW_LINE_MS = 250
STRONG_END_RE = re.compile(r"[.!?…][\"'’”)]*$")


@dataclass(frozen=True)
class Word:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str
    words: tuple[Word, ...] = ()
    log_probability: float | None = None


@dataclass(frozen=True)
class DiarizationTurn:
    start_ms: int
    end_ms: int
    speaker_id: str
    confidence: float | None = None
    boundary_speaker_id: str | None = None
    uncertain: bool = False
    stabilization_failed: bool = False


@dataclass(frozen=True)
class Transcript:
    segments: tuple[TranscriptSegment, ...]
    language: str | None = None
    language_probability: float | None = None


@dataclass
class _Token:
    segment_index: int
    start_ms: int
    end_ms: int
    text: str
    speaker_id: str
    boundary_speaker_id: str
    log_probability: float | None
    diarization_confidence: float | None
    warning_codes: set[str] = field(default_factory=set)


WARNING_TEXT = {
    "low_transcription_confidence": "Düşük transkripsiyon güveni; metni dinleyerek kontrol et.",
    "uncertain_speaker": "Konuşmacı belirsiz; doğru karaktere yeniden ata.",
    "overlapping_speech": "Üst üste konuşma algılandı; metin ve konuşmacıyı kontrol et.",
    "very_short_line": "Çok kısa replik; sınırları ve metni kontrol et.",
    "timing_review": "Konuşmacı değişimi nedeniyle zamanlama kontrol edilmeli.",
    "speaker_stabilization_failed": (
        "Konuşmacı kimliği sabitleme tamamlanamadı; ham diarization sonucu kullanıldı."
    ),
    "speech_not_detected": "Konuşma algılanamadı; ses kalitesi veya kaynak sesini kontrol et.",
}


def merge_to_draft(
    transcript: Transcript,
    turns: list[DiarizationTurn],
    duration_ms: int,
    *,
    transcription_model: str,
    diarization_model: str,
    device: str,
    diagnostics: dict[str, Any] | None = None,
) -> EditableDraft:
    """Match words to speakers, then create deterministic, correction-sized lines."""
    bounded_duration = max(1, int(duration_ms))
    normalized_turns, speaker_map = normalize_diarization_turns(turns, bounded_duration)
    tokens: list[_Token] = []
    previous_speaker: str | None = None

    for segment_index, segment in enumerate(
        sorted(transcript.segments, key=lambda item: (item.start_ms, item.end_ms, item.text))
    ):
        # Normal operation uses word timestamps and can split within one Whisper segment.
        source_words = segment.words or (Word(segment.start_ms, segment.end_ms, segment.text),)
        segment_tokens: list[_Token] = []
        for word in source_words:
            text = word.text.strip()
            if not text:
                continue
            start_ms = _clamp(word.start_ms, 0, bounded_duration - 1)
            end_ms = _clamp(word.end_ms, start_ms + 1, bounded_duration)
            chosen_turn, overlaps, uncertain = _choose_word_turn(
                start_ms, end_ms, normalized_turns, previous_speaker
            )
            speaker_id = chosen_turn.speaker_id if chosen_turn else "SPEAKER_UNKNOWN"
            boundary_speaker_id = (
                chosen_turn.boundary_speaker_id or chosen_turn.speaker_id
                if chosen_turn
                else "SPEAKER_UNKNOWN"
            )
            confidence = chosen_turn.confidence if chosen_turn else None
            codes: set[str] = set()
            if uncertain:
                codes.add("uncertain_speaker")
            if overlaps:
                codes.add("overlapping_speech")
            if chosen_turn and chosen_turn.stabilization_failed:
                codes.add("speaker_stabilization_failed")
            if segment.log_probability is not None and segment.log_probability < -1.0:
                codes.add("low_transcription_confidence")
            token = _Token(
                segment_index,
                start_ms,
                end_ms,
                text,
                speaker_id,
                boundary_speaker_id,
                segment.log_probability,
                confidence,
                codes,
            )
            segment_tokens.append(token)
            previous_speaker = speaker_id if speaker_id != "SPEAKER_UNKNOWN" else previous_speaker
        if len({token.speaker_id for token in segment_tokens}) > 1:
            for token in segment_tokens:
                token.warning_codes.add("timing_review")
        tokens.extend(segment_tokens)

    ordered_tokens = sorted(tokens, key=lambda item: (item.start_ms, item.end_ms, item.speaker_id))
    groups = segment_dialogue_tokens(ordered_tokens)

    first_seen: dict[str, int] = {}
    for index, token in enumerate(ordered_tokens):
        first_seen.setdefault(token.speaker_id, index)
    speaker_ids = sorted(first_seen, key=lambda speaker: (first_seen[speaker], speaker))
    character_ids = {speaker: stable_character_id(speaker) for speaker in speaker_ids}
    characters = [
        Character(id=character_ids[speaker], name=f"Konuşmacı {index + 1}")
        for index, speaker in enumerate(speaker_ids)
    ]

    lines: list[DialogueLine] = []
    line_analysis: list[LineAnalysis] = []
    warnings: list[Warning] = []
    for index, group in enumerate(groups, 1):
        line_id = f"ai-replik-{index:04d}"
        start_ms = min(token.start_ms for token in group)
        end_ms = max(token.end_ms for token in group)
        codes = set().union(*(token.warning_codes for token in group))
        if end_ms - start_ms < MIN_REVIEW_LINE_MS:
            codes.add("very_short_line")
        text = _join_tokens(token.text for token in group)
        speaker_id = group[0].speaker_id
        lines.append(
            DialogueLine(
                id=line_id,
                character_id=character_ids[speaker_id],
                text=text,
                start_ms=start_ms,
                end_ms=end_ms,
            )
        )
        log_values = [token.log_probability for token in group if token.log_probability is not None]
        diarization_values = [
            token.diarization_confidence
            for token in group
            if token.diarization_confidence is not None
        ]
        ordered_codes = sorted(codes)
        line_analysis.append(
            LineAnalysis(
                line_id=line_id,
                detected_speaker_id=speaker_id,
                transcript_log_probability=(
                    sum(log_values) / len(log_values) if log_values else None
                ),
                diarization_confidence=(
                    sum(diarization_values) / len(diarization_values)
                    if diarization_values
                    else None
                ),
                warning_codes=ordered_codes,
            )
        )
        warnings.extend(
            Warning(
                code=code,
                message=WARNING_TEXT[code],
                line_id=line_id,
                start_ms=start_ms,
                end_ms=end_ms,
            )
            for code in ordered_codes
        )

    if not lines:
        warnings.append(
            Warning(code="speech_not_detected", message=WARNING_TEXT["speech_not_detected"])
        )

    result = EditableDraft(
        characters=characters,
        lines=lines,
        analysis=Analysis(
            transcription_model=transcription_model,
            diarization_model=diarization_model,
            device="cuda" if device == "cuda" else "cpu",
            detected_language=transcript.language,
            language_probability=transcript.language_probability,
            line_analysis=line_analysis,
            warnings=warnings,
        ),
    )
    if diagnostics is not None:
        diagnostics.update(
            {
                "speakerLabelMap": speaker_map,
                "normalizedDiarizationTurns": [_turn_json(turn) for turn in normalized_turns],
                "uniqueSpeakerLabels": sorted({turn.speaker_id for turn in normalized_turns}),
                "overlapRegions": overlap_regions(normalized_turns),
                "wordAssignments": [
                    {
                        "segmentIndex": token.segment_index,
                        "startMs": token.start_ms,
                        "endMs": token.end_ms,
                        "text": token.text,
                        "speakerId": token.speaker_id,
                        "warningCodes": sorted(token.warning_codes),
                    }
                    for token in ordered_tokens
                ],
                "generatedLines": [line.model_dump(by_alias=True) for line in lines],
            }
        )
    return result


def normalize_diarization_turns(
    turns: list[DiarizationTurn], duration_ms: int
) -> tuple[list[DiarizationTurn], dict[str, str]]:
    """Clamp turns and map every distinct raw label to one stable internal label."""
    bounded = max(1, duration_ms)
    ordered = sorted(turns, key=lambda turn: (turn.start_ms, turn.end_ms, turn.speaker_id))
    labels: list[str] = []
    for turn in ordered:
        if turn.speaker_id not in labels:
            labels.append(turn.speaker_id)
    used: set[str] = set()
    mapping: dict[str, str] = {}
    for raw in labels:
        match = re.fullmatch(r"SPEAKER[_ -]?(\d+)", raw.strip(), re.IGNORECASE)
        candidate = f"SPEAKER_{int(match.group(1)):02d}" if match else ""
        if not candidate or candidate in used:
            index = 0
            while f"SPEAKER_{index:02d}" in used:
                index += 1
            candidate = f"SPEAKER_{index:02d}"
        mapping[raw] = candidate
        used.add(candidate)
    normalized = [
        DiarizationTurn(
            start_ms=_clamp(turn.start_ms, 0, bounded - 1),
            end_ms=_clamp(turn.end_ms, _clamp(turn.start_ms, 0, bounded - 1) + 1, bounded),
            speaker_id=mapping[turn.speaker_id],
            confidence=turn.confidence,
            boundary_speaker_id=turn.boundary_speaker_id or turn.speaker_id,
            uncertain=turn.uncertain,
            stabilization_failed=turn.stabilization_failed,
        )
        for turn in ordered
        if turn.end_ms > 0 and turn.start_ms < bounded and turn.end_ms > turn.start_ms
    ]
    return normalized, mapping


def choose_word_speaker(
    start_ms: int,
    end_ms: int,
    turns: list[DiarizationTurn],
    previous_speaker: str | None = None,
) -> tuple[str, float | None, bool, bool]:
    """Return speaker, confidence, overlap-warning and uncertain-warning flags."""
    chosen, overlaps, uncertain = _choose_word_turn(start_ms, end_ms, turns, previous_speaker)
    if chosen is None:
        return "SPEAKER_UNKNOWN", None, overlaps, uncertain
    return chosen.speaker_id, chosen.confidence, overlaps, uncertain


def _choose_word_turn(
    start_ms: int,
    end_ms: int,
    turns: list[DiarizationTurn],
    previous_speaker: str | None = None,
) -> tuple[DiarizationTurn | None, bool, bool]:
    scored: list[tuple[int, int, int, DiarizationTurn]] = []
    word_center = (start_ms + end_ms) // 2
    for turn in turns:
        exact = _intersection(start_ms, end_ms, turn.start_ms, turn.end_ms)
        tolerant = _intersection(
            start_ms,
            end_ms,
            turn.start_ms - WORD_TURN_TOLERANCE_MS,
            turn.end_ms + WORD_TURN_TOLERANCE_MS,
        )
        if tolerant <= 0:
            continue
        turn_center = (turn.start_ms + turn.end_ms) // 2
        scored.append((exact, tolerant, abs(word_center - turn_center), turn))
    if not scored:
        return None, False, True

    scored.sort(key=lambda item: (-item[0], -item[1], item[2], item[3].speaker_id))
    chosen = scored[0]
    previous = next((item for item in scored if item[3].speaker_id == previous_speaker), None)
    if previous and chosen[3].speaker_id != previous_speaker:
        evidence_gain = chosen[0] - previous[0]
        if (
            evidence_gain < SPEAKER_JITTER_MARGIN_MS
            and previous[1] >= chosen[1] - SPEAKER_JITTER_MARGIN_MS
        ):
            chosen = previous
    exact_speakers = {item[3].speaker_id for item in scored if item[0] > 0}
    uncertain = chosen[0] == 0 or chosen[3].uncertain
    return chosen[3], len(exact_speakers) > 1, uncertain


def segment_dialogue_tokens(tokens: list[_Token]) -> list[list[_Token]]:
    groups: list[list[_Token]] = []
    for token in tokens:
        if not groups:
            groups.append([token])
            continue
        group = groups[-1]
        previous = group[-1]
        gap = token.start_ms - previous.end_ms
        group_duration = max(previous.end_ms, token.end_ms) - group[0].start_ms
        should_break = (
            previous.speaker_id != token.speaker_id
            or previous.boundary_speaker_id != token.boundary_speaker_id
            or gap > MEANINGFUL_SPEECH_GAP_MS
            or group_duration > MAX_LINE_DURATION_MS
            or bool(STRONG_END_RE.search(previous.text))
        )
        if should_break:
            groups.append([token])
        else:
            group.append(token)
    return groups


def overlap_regions(turns: list[DiarizationTurn]) -> list[dict[str, Any]]:
    regions: list[dict[str, Any]] = []
    for index, left in enumerate(turns):
        for right in turns[index + 1 :]:
            if left.speaker_id == right.speaker_id:
                continue
            start_ms = max(left.start_ms, right.start_ms)
            end_ms = min(left.end_ms, right.end_ms)
            if end_ms > start_ms:
                regions.append(
                    {
                        "startMs": start_ms,
                        "endMs": end_ms,
                        "speakerIds": sorted((left.speaker_id, right.speaker_id)),
                    }
                )
    return regions


def normalize_speaker_id(value: str) -> str:
    """Compatibility helper for a single known pyannote-style label."""
    match = re.search(r"(\d+)$", value.upper())
    return f"SPEAKER_{int(match.group(1)):02d}" if match else "SPEAKER_UNKNOWN"


def stable_character_id(speaker_id: str) -> str:
    if speaker_id == "SPEAKER_UNKNOWN":
        return "speaker-unknown"
    return "speaker-" + speaker_id.rsplit("_", 1)[-1].lower()


def _turn_json(turn: DiarizationTurn) -> dict[str, Any]:
    return {
        "startMs": turn.start_ms,
        "endMs": turn.end_ms,
        "speakerId": turn.speaker_id,
        "confidence": turn.confidence,
        "boundarySpeakerId": turn.boundary_speaker_id,
        "uncertain": turn.uncertain,
        "stabilizationFailed": turn.stabilization_failed,
    }


def _intersection(start_a: int, end_a: int, start_b: int, end_b: int) -> int:
    return max(0, min(end_a, end_b) - max(start_a, start_b))


def _clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, int(value)))


def _join_tokens(parts: Iterable[str]) -> str:
    text = " ".join(part.strip() for part in parts if part.strip())
    return re.sub(r"\s+([,.;:!?])", r"\1", text).strip()
