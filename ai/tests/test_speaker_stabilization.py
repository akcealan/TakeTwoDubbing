import json
from pathlib import Path

import numpy as np

from take_two_ai.domain import DiarizationTurn
from take_two_ai.speaker_evaluation import permutation_invariant_turn_metrics
from take_two_ai.speaker_stabilization import (
    TurnAcousticEvidence,
    stabilize_scene_speakers,
)


def make_scene(raw, embeddings, durations, *, overlaps=None):
    turns = []
    evidence = []
    current = 0
    overlaps = overlaps or [0] * len(raw)
    for label, vector, duration, overlap in zip(raw, embeddings, durations, overlaps, strict=True):
        turns.append(DiarizationTurn(current, current + duration, label))
        evidence.append(
            TurnAcousticEvidence(np.asarray(vector, dtype=float), duration - overlap, overlap)
        )
        current += duration + 500
    return turns, evidence


def fixture_scenes():
    return json.loads(
        (Path(__file__).parent / "fixtures" / "speaker-stabilization.json").read_text(
            encoding="utf-8"
        )
    )["scenes"]


def test_privacy_safe_scene_fixtures_reduce_fragmentation_and_contamination():
    for scene in fixture_scenes():
        turns, evidence = make_scene(scene["raw"], scene["embeddings"], scene["durationsMs"])
        result = stabilize_scene_speakers(turns, evidence, scene.get("expectedCount"))
        raw_metrics = permutation_invariant_turn_metrics(scene["truth"], scene["raw"])
        final_labels = [turn.speaker_id for turn in result.turns]
        final_metrics = permutation_invariant_turn_metrics(scene["truth"], final_labels)
        assert result.changed is True
        assert final_metrics["turnAccuracy"] > raw_metrics["turnAccuracy"]
        assert (
            final_metrics["speakerFragmentationCount"] <= raw_metrics["speakerFragmentationCount"]
        )
        assert (
            final_metrics["speakerContaminationCount"] <= raw_metrics["speakerContaminationCount"]
        )


def test_similar_voices_are_not_merged_on_moderate_similarity():
    turns, evidence = make_scene(
        ["left", "right", "left", "right"],
        [[1, 0, 0], [0.72, 0.69, 0], [0.99, 0.03, 0], [0.70, 0.71, 0.02]],
        [2000, 2100, 1900, 2200],
    )
    result = stabilize_scene_speakers(turns, evidence)
    labels = [turn.speaker_id for turn in result.turns]
    assert result.changed is False
    assert labels[0] == labels[2]
    assert labels[1] == labels[3]
    assert labels[0] != labels[1]


def test_short_ambiguous_turn_preserves_baseline_and_gets_review_warning():
    turns, evidence = make_scene(
        ["A", "B", "A"],
        [[1, 0, 0], [0, 1, 0], [0.7, 0.7, 0]],
        [2200, 2100, 500],
    )
    result = stabilize_scene_speakers(turns, evidence)
    assert result.turns[2].speaker_id == "A"
    assert result.turns[2].uncertain is True
    assert result.turns[2].confidence is None


def test_weighted_prototype_assigns_short_turn_to_strong_long_voice():
    turns, evidence = make_scene(
        ["A", "B", "B", "A"],
        [[1, 0, 0], [0, 1, 0], [0.98, 0.04, 0], [0.99, 0.02, 0]],
        [3000, 2800, 500, 2400],
    )
    result = stabilize_scene_speakers(turns, evidence, expected_speaker_count=2)
    labels = [turn.speaker_id for turn in result.turns]
    assert result.changed is True
    assert labels[2] == labels[0] == labels[3]
    assert labels[1] != labels[0]
    assert result.turns[2].uncertain is False


def test_overlap_turn_is_excluded_from_strong_anchors():
    turns, evidence = make_scene(
        ["A", "B", "A"],
        [[1, 0], [0, 1], [0.98, 0.02]],
        [2000, 2000, 2000],
        overlaps=[0, 500, 0],
    )
    result = stabilize_scene_speakers(turns, evidence, include_vectors=True)
    assert result.diagnostics["turnEvidence"][1]["reliableAnchor"] is False


def test_output_is_deterministic_and_raw_labels_survive_when_baseline_wins():
    turns, evidence = make_scene(
        ["Alice", "Bob", "Alice", "Bob"],
        [[1, 0], [0, 1], [0.99, 0.01], [0.01, 0.99]],
        [1600, 1700, 1800, 1900],
    )
    first = stabilize_scene_speakers(turns, evidence)
    second = stabilize_scene_speakers(list(reversed(turns)), list(reversed(evidence)))
    assert [turn.speaker_id for turn in first.turns] == ["Alice", "Bob", "Alice", "Bob"]
    assert [turn.speaker_id for turn in second.turns] == ["Bob", "Alice", "Bob", "Alice"]


def test_permutation_invariant_metrics_ignore_arbitrary_label_names():
    metrics = permutation_invariant_turn_metrics(
        ["A", "B", "A", "C"], ["speaker-9", "speaker-2", "speaker-9", "speaker-7"]
    )
    assert metrics["turnAccuracy"] == 1.0
    assert metrics["speakerFragmentationCount"] == 0
    assert metrics["speakerContaminationCount"] == 0


def test_exact_count_is_a_constraint_on_the_same_stabilizer():
    scene = fixture_scenes()[0]
    turns, evidence = make_scene(scene["raw"], scene["embeddings"], scene["durationsMs"])
    result = stabilize_scene_speakers(turns, evidence, expected_speaker_count=3)
    assert len({turn.speaker_id for turn in result.turns}) == 3
    assert result.diagnostics["mode"] == "exact"
    assert result.diagnostics["userConstrainedSpeakerCount"] == 3
    assert result.diagnostics["automaticEstimatedSpeakerCount"] == 3


def test_raw_severe_undercount_does_not_limit_anchor_discovery():
    turns, evidence = make_scene(
        ["raw"] * 6,
        [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [0.99, 0.02, 0],
            [0.02, 0.99, 0],
            [0, 0.02, 0.99],
        ],
        [1800] * 6,
    )
    result = stabilize_scene_speakers(turns, evidence)
    assert len({turn.speaker_id for turn in result.turns}) == 3
    assert result.diagnostics["automaticEstimatedSpeakerCount"] == 3


def test_exact_count_conflict_retains_incompatible_identities():
    turns, evidence = make_scene(
        ["raw"] * 3,
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        [1800, 1800, 1800],
    )
    result = stabilize_scene_speakers(turns, evidence, expected_speaker_count=2)
    assert len({turn.speaker_id for turn in result.turns}) == 3
    assert result.diagnostics["countConstraintConflict"] is True
    assert result.diagnostics["reason"] == "exact_count_conflicts_with_acoustic_evidence"


def test_short_novel_speaker_is_preserved_as_a_confident_identity():
    turns, evidence = make_scene(
        ["raw", "raw", "raw"],
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        [1800, 1700, 500],
    )
    result = stabilize_scene_speakers(turns, evidence)
    assert len({turn.speaker_id for turn in result.turns}) == 3
    assert result.turns[2].uncertain is False
    assert result.diagnostics["turnIdentityDecisions"][2]["state"] == "novel"


def test_very_short_dissimilar_outlier_is_uncertain_and_not_novel():
    turns, evidence = make_scene(
        ["A", "B", "noise"],
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        [1800, 1700, 400],
    )
    result = stabilize_scene_speakers(turns, evidence)
    assert len({turn.speaker_id for turn in result.turns}) == 2
    assert result.turns[2].uncertain is True
    assert result.diagnostics["turnIdentityDecisions"][2]["state"] == "uncertain"


def test_representative_member_supports_variable_delivery_when_centroid_is_weaker():
    turns, evidence = make_scene(
        ["A", "A", "B", "B"],
        [[1, 0, 0], [0.4, 0.9165, 0], [0, 0, 1], [0.39, 0.92, 0]],
        [1800, 1800, 1800, 600],
    )
    result = stabilize_scene_speakers(turns, evidence)
    assert result.turns[3].speaker_id == result.turns[0].speaker_id
    decision = result.diagnostics["turnIdentityDecisions"][3]
    assert decision["state"] == "attached"
    assert (
        decision["candidates"][0]["representativeSimilarity"]
        > decision["candidates"][0]["prototypeSimilarity"]
    )


def test_overlap_cannot_link_survives_reassignment():
    turns = [DiarizationTurn(0, 2000, "A"), DiarizationTurn(500, 2500, "B")]
    evidence = [
        TurnAcousticEvidence(np.asarray([1.0, 0.0]), 500, 1500),
        TurnAcousticEvidence(np.asarray([0.99, 0.01]), 500, 1500),
    ]
    result = stabilize_scene_speakers(turns, evidence)
    assert result.turns[0].speaker_id != result.turns[1].speaker_id


def test_timing_boundaries_and_boundary_ids_survive_stabilization():
    turns, evidence = make_scene(
        ["raw", "raw", "raw"],
        [[1, 0], [0, 1], [0.99, 0.01]],
        [1800, 1700, 1900],
    )
    result = stabilize_scene_speakers(turns, evidence)
    assert [(turn.start_ms, turn.end_ms) for turn in result.turns] == [
        (turn.start_ms, turn.end_ms) for turn in turns
    ]
    assert [turn.boundary_speaker_id for turn in result.turns] == [
        turn.speaker_id for turn in turns
    ]
    assert result.diagnostics["partitionChanged"] is True


def test_partition_change_is_reported_even_when_one_literal_label_is_retained():
    turns, evidence = make_scene(
        ["raw"] * 4,
        [[1, 0], [0, 1], [0.99, 0.01], [0.01, 0.99]],
        [1800, 1800, 1800, 1800],
    )
    result = stabilize_scene_speakers(turns, evidence)
    after = result.diagnostics["clusterAssignmentAfter"]
    assert result.diagnostics["partitionChanged"] is True
    assert any(
        not item["literalLabelChanged"] and item["groupingRelationshipChanged"] for item in after
    )
