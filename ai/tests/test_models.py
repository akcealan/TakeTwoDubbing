import numpy as np
import torch

from take_two_ai.domain import DiarizationTurn
from take_two_ai.models import (
    adapt_pyannote_output,
    apply_pyannote_pipeline,
    diarization_annotation_to_turns,
    extract_turn_acoustic_evidence,
)


class Segment:
    def __init__(self, start, end):
        self.start = start
        self.end = end


class Annotation:
    def __init__(self, values):
        self.values = values

    def itertracks(self, yield_label=False):
        assert yield_label is True
        return iter((Segment(start, end), None, speaker) for start, end, speaker in self.values)

    def labels(self):
        return sorted({speaker for _, _, speaker in self.values})


class CommunityOutput:
    def __init__(self):
        self.speaker_diarization = Annotation(
            [(0.0, 1.1, "SPEAKER_00"), (0.8, 1.5, "SPEAKER_01"), (1.5, 1.7, "SPEAKER_02")]
        )
        self.exclusive_speaker_diarization = Annotation(
            [(0.0, 1.1, "SPEAKER_00"), (1.1, 1.5, "SPEAKER_01"), (1.5, 1.7, "SPEAKER_02")]
        )
        self.speaker_embeddings = np.asarray([[1.0, 0.0], [0.0, 1.0], [0.7, 0.7]])


def test_pyannote_adapter_preserves_labels_short_turn_and_regular_overlap():
    turns, diagnostics = adapt_pyannote_output(CommunityOutput())
    assert [turn.speaker_id for turn in turns] == [
        "SPEAKER_00",
        "SPEAKER_01",
        "SPEAKER_02",
    ]
    assert turns[2].end_ms - turns[2].start_ms == 200
    assert turns[0].end_ms > turns[1].start_ms
    assert diagnostics["pyannoteRepresentation"] == "speaker_diarization"
    assert len(diagnostics["exclusiveDiarizationTurns"]) == 3
    assert [item["speakerId"] for item in diagnostics["pyannoteSpeakerEmbeddings"]] == [
        "SPEAKER_00",
        "SPEAKER_01",
        "SPEAKER_02",
    ]


def test_annotation_adapter_is_deterministically_sorted_and_drops_invalid_turns():
    annotation = Annotation([(2.0, 2.5, "B"), (0.0, 1.0, "A"), (1.0, 1.0, "noise")])
    turns = diarization_annotation_to_turns(annotation)
    assert [(turn.start_ms, turn.end_ms, turn.speaker_id) for turn in turns] == [
        (0, 1000, "A"),
        (2000, 2500, "B"),
    ]


def test_exact_expected_speaker_count_uses_supported_pyannote_argument():
    calls = []

    def pipeline(audio, **kwargs):
        calls.append((audio, kwargs))
        return CommunityOutput()

    apply_pyannote_pipeline(pipeline, {"waveform": "fixture"}, 3)
    apply_pyannote_pipeline(pipeline, {"waveform": "fixture"}, None)
    assert calls == [
        ({"waveform": "fixture"}, {"num_speakers": 3}),
        ({"waveform": "fixture"}, {}),
    ]


def test_stabilization_failure_preserves_raw_diarization_with_truthful_review_marker():
    def pipeline(audio, **kwargs):
        return CommunityOutput()

    turns, diagnostics = apply_pyannote_pipeline(pipeline, {"waveform": "fixture"}, None)
    assert [turn.speaker_id for turn in turns] == [
        "SPEAKER_00",
        "SPEAKER_01",
        "SPEAKER_02",
    ]
    assert all(turn.stabilization_failed for turn in turns)
    assert diagnostics["sceneSpeakerStabilization"]["status"] == "baseline_retained"
    assert diagnostics["sceneSpeakerStabilization"]["reason"] == "stabilization_error"


def test_turn_embeddings_use_independent_exact_length_inputs():
    calls = []

    class Pipeline:
        def _embedding(self, waveform, masks=None):
            calls.append((tuple(waveform.shape), masks))
            return np.asarray([[float(waveform.shape[-1]), float(waveform.mean())]])

    waveform = torch.linspace(-1.0, 1.0, 96_000).unsqueeze(0)
    turns = [
        DiarizationTurn(1_000, 1_500, "short"),
        DiarizationTurn(2_000, 5_000, "long"),
    ]
    evidence = extract_turn_acoustic_evidence(
        Pipeline(), {"waveform": waveform, "sample_rate": 16_000}, turns
    )

    assert [shape for shape, _ in calls] == [(1, 1, 8_000), (1, 1, 48_000)]
    assert all(mask is None for _, mask in calls)
    assert evidence[0].source_sample_count == 8_000
    assert evidence[0].artificial_padding_samples == 0
    assert evidence[0].clean_spans == ((16_000, 24_000),)


def test_overlap_removal_embeds_only_contiguous_clean_spans():
    lengths = []

    class Pipeline:
        def _embedding(self, waveform, masks=None):
            lengths.append(waveform.shape[-1])
            return np.asarray([[1.0, float(waveform.shape[-1])]])

    waveform = torch.ones((1, 64_000))
    turns = [
        DiarizationTurn(0, 2_000, "A"),
        DiarizationTurn(800, 1_200, "B"),
    ]
    evidence = extract_turn_acoustic_evidence(
        Pipeline(), {"waveform": waveform, "sample_rate": 16_000}, turns
    )

    assert lengths == [12_800, 12_800]
    assert evidence[0].clean_spans == ((0, 12_800), (19_200, 32_000))
    assert evidence[0].overlap_masking_changed_crop is True
    assert evidence[1].embedding is None
