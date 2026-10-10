import json
from pathlib import Path

from take_two_ai.domain import (
    DiarizationTurn,
    Transcript,
    TranscriptSegment,
    Word,
    choose_word_speaker,
    merge_to_draft,
    normalize_diarization_turns,
)


def build(transcript: Transcript, turns: list[DiarizationTurn], duration: int = 5_000):
    return merge_to_draft(
        transcript,
        turns,
        duration,
        transcription_model="small",
        diarization_model="community-1",
        device="cpu",
    )


def test_multiple_speakers_changes_and_stable_ids_are_deterministic():
    transcript = Transcript(
        segments=(
            TranscriptSegment(
                100,
                2_000,
                "Merhaba nas sonra",
                (Word(100, 700, "Merhaba"), Word(1_200, 2_000, "sonra")),
                -0.2,
            ),
        ),
        language="tr",
        language_probability=0.91,
    )
    turns = [
        DiarizationTurn(0, 900, "SPEAKER_07"),
        DiarizationTurn(1_000, 2_100, "SPEAKER_02"),
    ]
    first = build(transcript, turns)
    second = build(transcript, list(reversed(turns)))
    assert first.model_dump() == second.model_dump()
    assert [item.id for item in first.characters] == ["speaker-07", "speaker-02"]
    assert [item.name for item in first.characters] == ["Konuşmacı 1", "Konuşmacı 2"]
    assert [item.character_id for item in first.lines] == ["speaker-07", "speaker-02"]
    assert [item.id for item in first.lines] == ["ai-replik-0001", "ai-replik-0002"]
    assert first.analysis.detected_language == "tr"
    assert first.analysis.language_probability == 0.91
    assert all("timing_review" in item.warning_codes for item in first.analysis.line_analysis)


def test_overlap_uncertain_confidence_and_clamping_are_preserved_as_warnings():
    transcript = Transcript(
        segments=(
            TranscriptSegment(
                -100,
                900,
                "aynı anda",
                (Word(-100, 100, "aynı"), Word(200, 900, "anda")),
                -1.4,
            ),
            TranscriptSegment(4_900, 7_000, "uzakta", (), -0.1),
        )
    )
    result = build(
        transcript,
        [
            DiarizationTurn(0, 800, "speaker_0"),
            DiarizationTurn(50, 700, "speaker_1"),
        ],
    )
    assert result.lines[0].start_ms == 0
    assert result.lines[-1].end_ms == 5_000
    codes = {warning.code for warning in result.analysis.warnings}
    assert "overlapping_speech" in codes
    assert "uncertain_speaker" in codes
    assert "low_transcription_confidence" in codes
    assert result.analysis.line_analysis[0].transcript_log_probability == -1.4
    assert result.analysis.line_analysis[0].diarization_confidence is None


def test_no_transcript_does_not_invent_dialogue():
    result = build(Transcript(segments=()), [DiarizationTurn(0, 1_000, "SPEAKER_00")])
    assert result.lines == []
    assert result.characters == []
    assert [warning.code for warning in result.analysis.warnings] == ["speech_not_detected"]


def test_privacy_safe_regression_fixture_splits_three_speakers_inside_one_segment():
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "multispeaker-merge.json").read_text(encoding="utf-8")
    )
    transcript = Transcript(
        segments=tuple(
            TranscriptSegment(
                item["startMs"],
                item["endMs"],
                item["text"],
                tuple(Word(*word) for word in item["words"]),
                item["logProbability"],
            )
            for item in fixture["segments"]
        )
    )
    turns = [DiarizationTurn(*turn) for turn in fixture["turns"]]
    diagnostics = {}
    result = merge_to_draft(
        transcript,
        turns,
        fixture["durationMs"],
        transcription_model="small",
        diarization_model="community-1",
        device="cpu",
        diagnostics=diagnostics,
    )

    assert [character.id for character in result.characters] == [
        "speaker-00",
        "speaker-01",
        "speaker-02",
    ]
    assert [line.character_id for line in result.lines[:3]] == [
        "speaker-00",
        "speaker-01",
        "speaker-02",
    ]
    assert result.lines[2].text == "Buradayım."
    assert any("overlapping_speech" in line.warning_codes for line in result.analysis.line_analysis)
    assert diagnostics["uniqueSpeakerLabels"] == [
        "SPEAKER_00",
        "SPEAKER_01",
        "SPEAKER_02",
    ]
    assert diagnostics["overlapRegions"]
    assert diagnostics["wordAssignments"][2]["segmentIndex"] == 0
    assert (
        build(transcript, list(reversed(turns)), fixture["durationMs"]).model_dump()
        == result.model_dump()
    )


def test_small_diarization_gap_uses_tolerance_but_marks_assignment_uncertain():
    turns, _ = normalize_diarization_turns([DiarizationTurn(0, 1_000, "SPEAKER_00")], 2_000)
    speaker, confidence, overlap, uncertain = choose_word_speaker(1_030, 1_090, turns)
    assert speaker == "SPEAKER_00"
    assert confidence is None
    assert overlap is False
    assert uncertain is True


def test_arbitrary_raw_labels_remain_unique_and_do_not_collapse_to_unknown():
    turns, mapping = normalize_diarization_turns(
        [
            DiarizationTurn(0, 500, "Alice"),
            DiarizationTurn(500, 1_000, "Bob"),
            DiarizationTurn(1_000, 1_150, "Guest"),
        ],
        2_000,
    )
    assert mapping == {
        "Alice": "SPEAKER_00",
        "Bob": "SPEAKER_01",
        "Guest": "SPEAKER_02",
    }
    assert [turn.speaker_id for turn in turns] == [
        "SPEAKER_00",
        "SPEAKER_01",
        "SPEAKER_02",
    ]


def test_punctuation_and_long_duration_prevent_giant_same_speaker_lines():
    transcript = Transcript(
        (
            TranscriptSegment(
                0,
                8_000,
                "Birinci cümle. İkinci bölüm devam ediyor",
                (
                    Word(0, 900, "Birinci"),
                    Word(920, 1_600, "cümle."),
                    Word(1_700, 2_400, "İkinci"),
                    Word(7_500, 8_000, "bölüm"),
                ),
            ),
        )
    )
    result = build(transcript, [DiarizationTurn(0, 8_100, "SPEAKER_00")], 8_100)
    assert [line.text for line in result.lines] == ["Birinci cümle.", "İkinci", "bölüm"]


def test_identity_stabilization_does_not_remove_existing_speaker_boundaries():
    transcript = Transcript(
        (
            TranscriptSegment(
                0,
                2_000,
                "Bir iki",
                (Word(100, 700, "Bir"), Word(1_100, 1_700, "iki")),
            ),
        )
    )
    turns = [
        DiarizationTurn(0, 900, "STABLE_A", boundary_speaker_id="RAW_1"),
        DiarizationTurn(1_000, 2_000, "STABLE_A", boundary_speaker_id="RAW_2"),
    ]
    result = build(transcript, turns)
    assert [line.text for line in result.lines] == ["Bir", "iki"]
    assert len({line.character_id for line in result.lines}) == 1


def test_stabilization_fallback_surfaces_warning_without_fabricating_confidence():
    transcript = Transcript((TranscriptSegment(0, 800, "Kontrol"),))
    turns = [
        DiarizationTurn(
            0,
            800,
            "SPEAKER_00",
            uncertain=True,
            stabilization_failed=True,
        )
    ]
    result = build(transcript, turns)
    analysis = result.analysis.line_analysis[0]
    assert "speaker_stabilization_failed" in analysis.warning_codes
    assert "uncertain_speaker" in analysis.warning_codes
    assert analysis.diarization_confidence is None
