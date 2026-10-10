from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Any

import numpy as np

from .domain import DiarizationTurn

# Identity thresholds are centralized here. They deliberately do not change speech timing.
MIN_EMBEDDING_TURN_MS = 300
SHORT_TURN_MS = 900
ANCHOR_MIN_DURATION_MS = 1_200
ANCHOR_MIN_CLEAN_MS = 1_000
ANCHOR_MIN_PURITY = 0.85
MAX_PROTOTYPE_WEIGHT_MS = 5_000
CANNOT_LINK_OVERLAP_MS = 100
SHORT_ASSIGN_MIN_SIMILARITY = 0.58
SHORT_ASSIGN_MIN_MARGIN = 0.07
ANCHOR_MERGE_MIN_SIMILARITY = 0.40
RAW_CROSS_LABEL_MERGE_MIN_SIMILARITY = 0.82
RAW_CROSS_LABEL_SINGLETON_MERGE_MIN_SIMILARITY = 0.70
ATTACH_MIN_SUPPORT = 0.40
ATTACH_MIN_REPRESENTATIVE = 0.38
ATTACH_MIN_MARGIN = 0.08
NOVEL_MAX_SUPPORT = 0.32
NOVEL_MIN_DURATION_MS = 450
NOVEL_MIN_PURITY = 0.85
MAX_REPRESENTATIVES_PER_SPEAKER = 4
AUTOMATIC_MERGE_COUNT_RADIUS = 2
AUTOMATIC_SPLIT_COUNT_RADIUS = 1
AUTOMATIC_COMPLEXITY_PENALTY = 0.025
AUTOMATIC_COUNT_CHANGE_PENALTY = 0.015
WEAK_SINGLETON_PENALTY = 0.04
MIN_AUTOMATIC_IMPROVEMENT = 0.03
MIN_EXACT_IMPROVEMENT = 0.015
MAX_SCENE_TURNS = 400
MAX_DIAGNOSTIC_PAIRS = 2_000


@dataclass(frozen=True)
class TurnAcousticEvidence:
    embedding: np.ndarray | None
    clean_ms: int
    overlap_ms: int
    crop_start_sample: int | None = None
    crop_end_sample: int | None = None
    source_sample_count: int = 0
    artificial_padding_samples: int = 0
    overlap_masking_changed_crop: bool = False
    clean_spans: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True)
class StabilizationResult:
    turns: list[DiarizationTurn]
    diagnostics: dict[str, Any]
    changed: bool


def stabilize_scene_speakers(
    turns: list[DiarizationTurn],
    evidence: list[TurnAcousticEvidence],
    expected_speaker_count: int | None = None,
    *,
    include_vectors: bool = False,
) -> StabilizationResult:
    """Build identities from clean anchors, then classify weaker turns conservatively."""
    if len(turns) != len(evidence):
        raise ValueError("Every diarization turn must have matching acoustic evidence.")

    baseline_count = len({turn.speaker_id for turn in turns})
    mode = "exact" if expected_speaker_count is not None else "automatic"
    base_diagnostics: dict[str, Any] = {
        "status": "baseline_retained",
        "mode": mode,
        "pyannoteSpeakerCount": baseline_count,
        "userConstrainedSpeakerCount": expected_speaker_count,
    }
    if not turns:
        return StabilizationResult(turns=[], diagnostics=base_diagnostics, changed=False)
    if len(turns) > MAX_SCENE_TURNS:
        base_diagnostics["reason"] = "scene_turn_limit"
        return StabilizationResult(
            turns=_mark_failed(turns), diagnostics=base_diagnostics, changed=False
        )

    vectors: list[np.ndarray | None] = []
    qualities: list[dict[str, Any]] = []
    valid_indices: list[int] = []
    anchor_indices: set[int] = set()
    weights: list[float] = []
    for index, (turn, item) in enumerate(zip(turns, evidence, strict=True)):
        duration_ms = max(0, turn.end_ms - turn.start_ms)
        vector = _unit_vector(item.embedding)
        usable = vector is not None and duration_ms >= MIN_EMBEDDING_TURN_MS
        purity = item.clean_ms / duration_ms if duration_ms else 0.0
        anchor = bool(
            usable
            and duration_ms >= ANCHOR_MIN_DURATION_MS
            and item.clean_ms >= ANCHOR_MIN_CLEAN_MS
            and purity >= ANCHOR_MIN_PURITY
        )
        weight = max(1.0, min(item.clean_ms, MAX_PROTOTYPE_WEIGHT_MS)) * max(0.1, purity)
        vectors.append(vector)
        weights.append(weight)
        if usable:
            valid_indices.append(index)
        if anchor:
            anchor_indices.add(index)
        detail: dict[str, Any] = {
            "turnIndex": index,
            "startMs": turn.start_ms,
            "endMs": turn.end_ms,
            "durationMs": duration_ms,
            "baselineSpeakerId": turn.speaker_id,
            "cleanMs": item.clean_ms,
            "overlapMs": item.overlap_ms,
            "embeddingAvailable": vector is not None,
            "reliableAnchor": anchor,
            "shortOrUncertain": duration_ms < SHORT_TURN_MS or not anchor,
            "cropStartSample": item.crop_start_sample,
            "cropEndSample": item.crop_end_sample,
            "sourceSampleCount": item.source_sample_count,
            "artificialPaddingSamples": item.artificial_padding_samples,
            "overlapMaskingChangedCrop": item.overlap_masking_changed_crop,
            "cleanSampleSpans": [list(span) for span in item.clean_spans],
            "embeddingProcessingMode": "independent_clean_spans",
        }
        if include_vectors and vector is not None:
            detail["embedding"] = [round(float(value), 7) for value in vector]
        qualities.append(detail)

    base_diagnostics["turnEvidence"] = qualities
    if len(valid_indices) < 2 or not anchor_indices:
        base_diagnostics["reason"] = "insufficient_reliable_embeddings"
        uncertain = _baseline_uncertainty(turns, vectors, anchor_indices, weights)
        return StabilizationResult(
            turns=_apply_assignments(turns, [turn.speaker_id for turn in turns], uncertain),
            diagnostics=_finish_diagnostics(
                base_diagnostics,
                turns,
                [turn.speaker_id for turn in turns],
                vectors,
                weights,
                anchor_indices,
                include_vectors,
            ),
            changed=False,
        )

    local_vectors = [vectors[index] for index in valid_indices]
    if any(vector is None for vector in local_vectors):
        raise AssertionError("Valid turn indices must contain finite vectors.")
    matrix = np.vstack(local_vectors)  # type: ignore[arg-type]
    local_weights = [weights[index] for index in valid_indices]
    forbidden = _cannot_link_pairs(turns, valid_indices)
    anchor_local = [
        local_index
        for local_index, turn_index in enumerate(valid_indices)
        if turn_index in anchor_indices
    ]
    chosen_assignments, representatives, anchor_decisions = _discover_anchor_identities(
        matrix,
        local_weights,
        anchor_local,
        valid_indices,
        turns,
        forbidden,
        expected_speaker_count,
    )
    uncertain_local: set[int] = set()
    turn_decisions: list[dict[str, Any]] = []
    next_cluster = max(chosen_assignments.values(), default=-1) + 1
    for local_index, turn_index in sorted(
        enumerate(valid_indices), key=lambda item: (turns[item[1]].start_ms, item[1])
    ):
        if local_index in chosen_assignments:
            turn_decisions.append(
                {
                    "turnIndex": turn_index,
                    "state": "anchor",
                    "selectedCluster": chosen_assignments[local_index],
                    "reason": "reliable_clean_anchor",
                }
            )
            continue
        ranked = _rank_identity_support(
            local_index, matrix, local_weights, representatives, forbidden
        )
        duration = turns[turn_index].end_ms - turns[turn_index].start_ms
        item = evidence[turn_index]
        purity = item.clean_ms / duration if duration else 0.0
        best = ranked[0] if ranked else None
        second_support = ranked[1][0] if len(ranked) > 1 else -1.0
        if (
            best is not None
            and best[0] >= ATTACH_MIN_SUPPORT
            and best[1] >= ATTACH_MIN_REPRESENTATIVE
            and best[0] - second_support >= ATTACH_MIN_MARGIN
        ):
            cluster = best[2]
            state = "attached"
            reason = "supported_by_anchor_representatives"
        elif (
            duration >= NOVEL_MIN_DURATION_MS
            and purity >= NOVEL_MIN_PURITY
            and (best is None or best[0] <= NOVEL_MAX_SUPPORT)
        ):
            cluster = next_cluster
            next_cluster += 1
            representatives[cluster] = [local_index]
            state = "novel"
            reason = "dissimilar_from_all_established_anchors"
        else:
            cluster = best[2] if best is not None else next_cluster
            if best is None:
                next_cluster += 1
                representatives[cluster] = [local_index]
            uncertain_local.add(local_index)
            state = "uncertain"
            reason = "insufficient_or_ambiguous_acoustic_support"
        chosen_assignments[local_index] = cluster
        turn_decisions.append(
            {
                "turnIndex": turn_index,
                "state": state,
                "selectedCluster": cluster,
                "reason": reason,
                "candidates": [
                    {
                        "cluster": candidate_cluster,
                        "support": round(support, 7),
                        "representativeSimilarity": round(representative_similarity, 7),
                        "prototypeSimilarity": round(prototype_similarity, 7),
                    }
                    for support, representative_similarity, candidate_cluster, prototype_similarity in ranked
                ],
            }
        )

    local_assignment = _canonicalize([chosen_assignments[index] for index in range(len(matrix))])
    natural_count = len(set(local_assignment))
    base_diagnostics["automaticEstimatedSpeakerCount"] = natural_count
    base_diagnostics["anchorDecisions"] = anchor_decisions
    base_diagnostics["turnIdentityDecisions"] = turn_decisions
    base_diagnostics["representativeMembers"] = {
        str(cluster): [valid_indices[index] for index in members]
        for cluster, members in sorted(representatives.items())
    }

    full_cluster_assignments: list[int | str] = [turn.speaker_id for turn in turns]
    for local_index, turn_index in enumerate(valid_indices):
        full_cluster_assignments[turn_index] = local_assignment[local_index]
    _assign_unusable_from_baseline(full_cluster_assignments, turns, valid_indices, weights)

    mapped_labels = _map_clusters_to_baseline(full_cluster_assignments, turns, weights)
    candidate_partition = [mapped_labels[value] for value in full_cluster_assignments]
    baseline_partition = [turn.speaker_id for turn in turns]
    changed = not _same_partition(candidate_partition, baseline_partition)
    full_candidate_count = len(set(candidate_partition))
    count_conflict = (
        expected_speaker_count is not None and full_candidate_count != expected_speaker_count
    )
    constraint_safe = not _assignment_violates_cannot_link(local_assignment, forbidden)
    accepted = changed and constraint_safe

    if accepted:
        selected_labels = candidate_partition
        selected_uncertain = {valid_indices[index] for index in uncertain_local} | {
            index for index in range(len(turns)) if index not in valid_indices
        }
        base_diagnostics["status"] = "applied"
        if count_conflict:
            base_diagnostics["reason"] = "exact_count_conflicts_with_acoustic_evidence"
    else:
        selected_labels = baseline_partition
        selected_uncertain = _baseline_uncertainty(turns, vectors, anchor_indices, weights)
        if changed and not constraint_safe:
            base_diagnostics["reason"] = "candidate_violates_overlap_constraint"
        elif not changed:
            base_diagnostics["reason"] = "baseline_already_best"

    base_diagnostics.update(
        {
            "selectedSpeakerCount": len(set(selected_labels)),
            "countConstraintConflict": count_conflict,
            "selectionModel": "anchor_coherence_and_turn_support_v2",
            "rawBaselineProtected": not accepted,
        }
    )
    final_turns = _apply_assignments(turns, selected_labels, selected_uncertain)
    return StabilizationResult(
        turns=final_turns,
        diagnostics=_finish_diagnostics(
            base_diagnostics,
            turns,
            selected_labels,
            vectors,
            weights,
            anchor_indices,
            include_vectors,
        ),
        changed=accepted,
    )


def _discover_anchor_identities(
    matrix: np.ndarray,
    weights: list[float],
    anchor_local: list[int],
    valid_indices: list[int],
    turns: list[DiarizationTurn],
    forbidden: set[tuple[int, int]],
    expected_speaker_count: int | None,
) -> tuple[dict[int, int], dict[int, list[int]], list[dict[str, Any]]]:
    """Agglomerate only strong anchors; raw labels protect unsupported cross-label merges."""
    clusters: list[tuple[int, ...]] = [(index,) for index in anchor_local]
    decisions: list[dict[str, Any]] = []
    while len(clusters) > 1:
        label_cluster_counts: dict[str, int] = {}
        for cluster in clusters:
            for label in {turns[valid_indices[index]].speaker_id for index in cluster}:
                label_cluster_counts[label] = label_cluster_counts.get(label, 0) + 1
        choices: list[tuple[float, tuple[int, ...], tuple[int, ...], float, float]] = []
        for left_index, right_index in combinations(range(len(clusters)), 2):
            left, right = clusters[left_index], clusters[right_index]
            if any(_ordered_pair(a, b) in forbidden for a in left for b in right):
                continue
            prototype_similarity = float(
                np.dot(
                    _prototype(matrix, weights, left),
                    _prototype(matrix, weights, right),
                )
            )
            representative_similarity = max(
                float(np.dot(matrix[a], matrix[b])) for a in left for b in right
            )
            left_labels = {turns[valid_indices[index]].speaker_id for index in left}
            right_labels = {turns[valid_indices[index]].speaker_id for index in right}
            fragmented_raw_identity = any(
                label_cluster_counts[label] > 1 for label in left_labels | right_labels
            )
            if left_labels & right_labels or fragmented_raw_identity:
                threshold = ANCHOR_MERGE_MIN_SIMILARITY
            elif (
                expected_speaker_count is not None
                and len(clusters) > expected_speaker_count
                and min(len(left), len(right)) == 1
            ):
                threshold = RAW_CROSS_LABEL_SINGLETON_MERGE_MIN_SIMILARITY
            else:
                threshold = RAW_CROSS_LABEL_MERGE_MIN_SIMILARITY
            support = 0.65 * prototype_similarity + 0.35 * representative_similarity
            if prototype_similarity >= threshold and representative_similarity >= threshold:
                choices.append(
                    (-support, left, right, prototype_similarity, representative_similarity)
                )
            else:
                if len(decisions) < MAX_DIAGNOSTIC_PAIRS:
                    decisions.append(
                        {
                            "action": "merge_rejected",
                            "leftTurnIndices": [valid_indices[index] for index in left],
                            "rightTurnIndices": [valid_indices[index] for index in right],
                            "prototypeSimilarity": round(prototype_similarity, 7),
                            "representativeSimilarity": round(representative_similarity, 7),
                            "requiredSimilarity": threshold,
                            "reason": "insufficient_multi_member_acoustic_support",
                        }
                    )
        if not choices:
            break
        _, left, right, prototype_similarity, representative_similarity = min(choices)
        merged = tuple(sorted(left + right))
        clusters = [cluster for cluster in clusters if cluster not in {left, right}] + [merged]
        clusters.sort()
        if len(decisions) < MAX_DIAGNOSTIC_PAIRS:
            decisions.append(
                {
                    "action": "merge_accepted",
                    "leftTurnIndices": [valid_indices[index] for index in left],
                    "rightTurnIndices": [valid_indices[index] for index in right],
                    "prototypeSimilarity": round(prototype_similarity, 7),
                    "representativeSimilarity": round(representative_similarity, 7),
                    "reason": "coherent_anchor_evidence",
                }
            )

    assignment: dict[int, int] = {}
    representatives: dict[int, list[int]] = {}
    for cluster_id, members in enumerate(clusters):
        for member in members:
            assignment[member] = cluster_id
        representatives[cluster_id] = _select_representatives(matrix, weights, members)
    return assignment, representatives, decisions


def _select_representatives(
    matrix: np.ndarray, weights: list[float], members: tuple[int, ...]
) -> list[int]:
    """Keep a bounded, deterministic set of clean members instead of one centroid alone."""
    prototype = _prototype(matrix, weights, members)
    ranked = sorted(
        members,
        key=lambda index: (-float(np.dot(matrix[index], prototype)), -weights[index], index),
    )
    return ranked[:MAX_REPRESENTATIVES_PER_SPEAKER]


def _rank_identity_support(
    local_index: int,
    matrix: np.ndarray,
    weights: list[float],
    representatives: dict[int, list[int]],
    forbidden: set[tuple[int, int]],
) -> list[tuple[float, float, int, float]]:
    ranked: list[tuple[float, float, int, float]] = []
    for cluster, members in representatives.items():
        if any(_ordered_pair(local_index, member) in forbidden for member in members):
            continue
        prototype = _prototype(matrix, weights, tuple(members))
        prototype_similarity = float(np.dot(matrix[local_index], prototype))
        representative_similarity = max(
            float(np.dot(matrix[local_index], matrix[member])) for member in members
        )
        support = 0.55 * prototype_similarity + 0.45 * representative_similarity
        ranked.append((support, representative_similarity, cluster, prototype_similarity))
    return sorted(ranked, key=lambda item: (-item[0], -item[1], item[2]))


def _assignment_violates_cannot_link(
    assignment: list[int], forbidden: set[tuple[int, int]]
) -> bool:
    return any(assignment[left] == assignment[right] for left, right in forbidden)


def _choose_automatic_partition(
    hierarchy: dict[int, list[int]],
    baseline: list[str],
    matrix: np.ndarray,
    weights: list[float],
    valid_indices: list[int],
    turns: list[DiarizationTurn],
    anchors: set[int],
) -> tuple[list[int], int, float, set[int]]:
    baseline_count = len(set(baseline))
    minimum = max(1, baseline_count - AUTOMATIC_MERGE_COUNT_RADIUS)
    maximum = min(12, len(baseline), baseline_count + AUTOMATIC_SPLIT_COUNT_RADIUS)
    candidates: list[tuple[float, int, list[int], set[int]]] = []
    for count in range(minimum, maximum + 1):
        partition = hierarchy.get(count)
        if partition is None:
            continue
        refined, uncertain = _refine_uncertain_turns(
            partition, matrix, weights, valid_indices, turns, anchors
        )
        actual_count = len(set(refined))
        score = _selection_score(
            refined,
            matrix,
            weights,
            actual_count,
            baseline_count,
            valid_indices,
            anchors,
        )
        candidates.append((score, actual_count, refined, uncertain))
    if not candidates:
        fallback = list(range(len(baseline)))
        return fallback, len(fallback), -1.0, set(range(len(fallback)))
    candidates.sort(key=lambda item: (-item[0], abs(item[1] - baseline_count), item[1], item[2]))
    score, count, assignment, uncertain = candidates[0]
    return assignment, count, score, uncertain


def _agglomerative_hierarchy(
    matrix: np.ndarray, weights: list[float], forbidden: set[tuple[int, int]]
) -> dict[int, list[int]]:
    clusters: list[tuple[int, ...]] = [(index,) for index in range(len(matrix))]
    hierarchy = {len(clusters): list(range(len(clusters)))}
    while len(clusters) > 1:
        choices: list[tuple[float, tuple[int, ...], tuple[int, ...], int, int]] = []
        for left_index, right_index in combinations(range(len(clusters)), 2):
            left, right = clusters[left_index], clusters[right_index]
            if any(_ordered_pair(a, b) in forbidden for a in left for b in right):
                continue
            similarity = _cluster_similarity(matrix, weights, left, right)
            choices.append((-similarity, left, right, left_index, right_index))
        if not choices:
            break
        _, _, _, left_index, right_index = min(choices)
        merged = tuple(sorted(clusters[left_index] + clusters[right_index]))
        clusters = [
            cluster
            for index, cluster in enumerate(clusters)
            if index not in {left_index, right_index}
        ] + [merged]
        clusters.sort()
        assignment = [0] * len(matrix)
        for cluster_index, cluster in enumerate(clusters):
            for member in cluster:
                assignment[member] = cluster_index
        hierarchy[len(clusters)] = assignment
    return hierarchy


def _cluster_similarity(
    matrix: np.ndarray,
    weights: list[float],
    left: tuple[int, ...],
    right: tuple[int, ...],
) -> float:
    left_centroid = _prototype(matrix, weights, left)
    right_centroid = _prototype(matrix, weights, right)
    return float(np.dot(left_centroid, right_centroid))


def _refine_uncertain_turns(
    assignment: list[int],
    matrix: np.ndarray,
    weights: list[float],
    valid_indices: list[int],
    turns: list[DiarizationTurn],
    anchors: set[int],
) -> tuple[list[int], set[int]]:
    refined = list(assignment)
    anchor_members: dict[int, list[int]] = {}
    for local_index, cluster in enumerate(assignment):
        if valid_indices[local_index] in anchors:
            anchor_members.setdefault(cluster, []).append(local_index)
    prototypes = {
        cluster: _prototype(matrix, weights, tuple(members))
        for cluster, members in anchor_members.items()
    }
    uncertain: set[int] = set()
    for local_index, turn_index in enumerate(valid_indices):
        duration = turns[turn_index].end_ms - turns[turn_index].start_ms
        if turn_index in anchors:
            continue
        ranked = sorted(
            (
                (float(np.dot(matrix[local_index], prototype)), cluster)
                for cluster, prototype in prototypes.items()
            ),
            key=lambda item: (-item[0], item[1]),
        )
        if ranked:
            best_similarity, best_cluster = ranked[0]
            second_similarity = ranked[1][0] if len(ranked) > 1 else -1.0
            if (
                best_similarity >= SHORT_ASSIGN_MIN_SIMILARITY
                and best_similarity - second_similarity >= SHORT_ASSIGN_MIN_MARGIN
            ):
                refined[local_index] = best_cluster
                continue
        if duration < SHORT_TURN_MS or assignment[local_index] not in prototypes:
            uncertain.add(local_index)
    return _canonicalize(refined), uncertain


def _selection_score(
    assignment: list[int] | list[str],
    matrix: np.ndarray,
    weights: list[float],
    count: int,
    baseline_count: int,
    valid_indices: list[int],
    anchors: set[int],
    *,
    exact: bool = False,
) -> float:
    score = _weighted_silhouette(assignment, matrix, weights)
    if not exact:
        score -= AUTOMATIC_COMPLEXITY_PENALTY * max(0, count - 1)
        score -= AUTOMATIC_COUNT_CHANGE_PENALTY * abs(count - baseline_count)
    cluster_members: dict[int | str, list[int]] = {}
    for local_index, cluster in enumerate(assignment):
        cluster_members.setdefault(cluster, []).append(local_index)
    weak_singletons = sum(
        1
        for members in cluster_members.values()
        if len(members) == 1 and valid_indices[members[0]] not in anchors
    )
    score -= WEAK_SINGLETON_PENALTY * weak_singletons / max(1, len(assignment))
    return float(score)


def _weighted_silhouette(
    assignment: list[int] | list[str], matrix: np.ndarray, weights: list[float]
) -> float:
    if len(set(assignment)) < 2:
        return -0.25
    distances = 1.0 - np.clip(matrix @ matrix.T, -1.0, 1.0)
    values: list[float] = []
    value_weights: list[float] = []
    for index, cluster in enumerate(assignment):
        same = [
            other for other, value in enumerate(assignment) if value == cluster and other != index
        ]
        if not same:
            values.append(0.0)
            value_weights.append(weights[index])
            continue
        a = _weighted_average(
            [float(distances[index, other]) for other in same], [weights[o] for o in same]
        )
        alternatives: list[float] = []
        for other_cluster in sorted(set(assignment), key=str):
            if other_cluster == cluster:
                continue
            members = [other for other, value in enumerate(assignment) if value == other_cluster]
            alternatives.append(
                _weighted_average(
                    [float(distances[index, other]) for other in members],
                    [weights[other] for other in members],
                )
            )
        b = min(alternatives)
        denominator = max(a, b)
        values.append((b - a) / denominator if denominator > 1e-9 else 0.0)
        value_weights.append(weights[index])
    return _weighted_average(values, value_weights)


def _baseline_uncertainty(
    turns: list[DiarizationTurn],
    vectors: list[np.ndarray | None],
    anchors: set[int],
    weights: list[float],
) -> set[int]:
    uncertain: set[int] = set()
    by_label: dict[str, list[int]] = {}
    for index in anchors:
        by_label.setdefault(turns[index].speaker_id, []).append(index)
    prototypes = {
        label: _prototype_from_global(vectors, weights, members)
        for label, members in by_label.items()
    }
    for index, (turn, vector) in enumerate(zip(turns, vectors, strict=True)):
        if index in anchors:
            continue
        duration = turn.end_ms - turn.start_ms
        if vector is None:
            uncertain.add(index)
            continue
        ranked = sorted(
            ((float(np.dot(vector, prototype)), label) for label, prototype in prototypes.items()),
            key=lambda item: (-item[0], item[1]),
        )
        if not ranked:
            uncertain.add(index)
            continue
        best_similarity, best_label = ranked[0]
        margin = best_similarity - (ranked[1][0] if len(ranked) > 1 else -1.0)
        if duration < SHORT_TURN_MS and (
            best_label != turn.speaker_id
            or best_similarity < SHORT_ASSIGN_MIN_SIMILARITY
            or margin < SHORT_ASSIGN_MIN_MARGIN
        ):
            uncertain.add(index)
    return uncertain


def _finish_diagnostics(
    diagnostics: dict[str, Any],
    turns: list[DiarizationTurn],
    selected_labels: list[str],
    vectors: list[np.ndarray | None],
    weights: list[float],
    anchors: set[int],
    include_vectors: bool,
) -> dict[str, Any]:
    baseline_labels = [turn.speaker_id for turn in turns]
    partition_changed = not _same_partition(selected_labels, baseline_labels)
    diagnostics["partitionChanged"] = partition_changed
    diagnostics["clusterAssignmentBefore"] = [
        {"turnIndex": index, "speakerId": turn.speaker_id} for index, turn in enumerate(turns)
    ]
    diagnostics["clusterAssignmentAfter"] = [
        {
            "turnIndex": index,
            "speakerId": selected_labels[index],
            "changed": selected_labels[index] != turn.speaker_id,
            "literalLabelChanged": selected_labels[index] != turn.speaker_id,
            "groupingRelationshipChanged": any(
                (selected_labels[index] == selected_labels[other])
                != (turn.speaker_id == turns[other].speaker_id)
                for other in range(len(turns))
            ),
        }
        for index, turn in enumerate(turns)
    ]
    valid = [index for index, vector in enumerate(vectors) if vector is not None]
    if include_vectors:
        pairs = sorted(
            (
                {
                    "leftTurnIndex": left,
                    "rightTurnIndex": right,
                    "cosineSimilarity": round(float(np.dot(vectors[left], vectors[right])), 7),  # type: ignore[arg-type]
                }
                for left, right in combinations(valid, 2)
            ),
            key=lambda item: (
                -item["cosineSimilarity"],
                item["leftTurnIndex"],
                item["rightTurnIndex"],
            ),
        )[:MAX_DIAGNOSTIC_PAIRS]
        diagnostics["pairwiseTurnSimilarities"] = pairs
        prototypes: dict[str, list[int]] = {}
        for index in anchors:
            prototypes.setdefault(selected_labels[index], []).append(index)
        diagnostics["weightedSpeakerPrototypes"] = [
            {
                "speakerId": label,
                "anchorTurnIndices": members,
                "embedding": [
                    round(float(value), 7)
                    for value in _prototype_from_global(vectors, weights, members)
                ],
            }
            for label, members in sorted(prototypes.items())
        ]
        prototype_vectors = {
            label: _prototype_from_global(vectors, weights, members)
            for label, members in prototypes.items()
        }
        diagnostics["turnPrototypeSimilarities"] = [
            {
                "turnIndex": index,
                "selectedSpeakerId": selected_labels[index],
                "similarities": {
                    label: round(float(np.dot(vectors[index], prototype)), 7)  # type: ignore[arg-type]
                    for label, prototype in sorted(prototype_vectors.items())
                },
            }
            for index in valid
        ]
    return diagnostics


def _cannot_link_pairs(
    turns: list[DiarizationTurn], valid_indices: list[int]
) -> set[tuple[int, int]]:
    forbidden: set[tuple[int, int]] = set()
    for left_local, right_local in combinations(range(len(valid_indices)), 2):
        left = turns[valid_indices[left_local]]
        right = turns[valid_indices[right_local]]
        overlap = max(0, min(left.end_ms, right.end_ms) - max(left.start_ms, right.start_ms))
        if overlap >= CANNOT_LINK_OVERLAP_MS and left.speaker_id != right.speaker_id:
            forbidden.add((left_local, right_local))
    return forbidden


def _assign_unusable_from_baseline(
    assignments: list[int | str],
    turns: list[DiarizationTurn],
    valid_indices: list[int],
    weights: list[float],
) -> None:
    votes: dict[str, dict[int | str, float]] = {}
    for index in valid_indices:
        votes.setdefault(turns[index].speaker_id, {}).setdefault(assignments[index], 0.0)
        votes[turns[index].speaker_id][assignments[index]] += weights[index]
    valid = set(valid_indices)
    for index, turn in enumerate(turns):
        if index in valid or turn.speaker_id not in votes:
            continue
        assignments[index] = min(
            votes[turn.speaker_id],
            key=lambda cluster: (-votes[turn.speaker_id][cluster], str(cluster)),
        )


def _map_clusters_to_baseline(
    assignments: list[int | str], turns: list[DiarizationTurn], weights: list[float]
) -> dict[int | str, str]:
    clusters = sorted(set(assignments), key=str)
    labels = sorted({turn.speaker_id for turn in turns})
    edges: list[tuple[float, str, int | str]] = []
    for cluster in clusters:
        for label in labels:
            overlap = sum(
                weights[index]
                for index, value in enumerate(assignments)
                if value == cluster and turns[index].speaker_id == label
            )
            edges.append((-overlap, label, cluster))
    mapping: dict[int | str, str] = {}
    used_labels: set[str] = set()
    for negative_overlap, label, cluster in sorted(
        edges, key=lambda item: (item[0], item[1], str(item[2]))
    ):
        if negative_overlap == 0 or cluster in mapping or label in used_labels:
            continue
        mapping[cluster] = label
        used_labels.add(label)
    next_index = 0
    for cluster in clusters:
        if cluster in mapping:
            continue
        while f"STABILIZED_{next_index:02d}" in used_labels:
            next_index += 1
        mapping[cluster] = f"STABILIZED_{next_index:02d}"
        used_labels.add(mapping[cluster])
        next_index += 1
    return mapping


def _apply_assignments(
    turns: list[DiarizationTurn], labels: list[str], uncertain: set[int]
) -> list[DiarizationTurn]:
    return [
        DiarizationTurn(
            start_ms=turn.start_ms,
            end_ms=turn.end_ms,
            speaker_id=labels[index],
            confidence=turn.confidence,
            boundary_speaker_id=turn.boundary_speaker_id or turn.speaker_id,
            uncertain=turn.uncertain or index in uncertain,
            stabilization_failed=turn.stabilization_failed,
        )
        for index, turn in enumerate(turns)
    ]


def _mark_failed(turns: list[DiarizationTurn]) -> list[DiarizationTurn]:
    return [
        DiarizationTurn(
            turn.start_ms,
            turn.end_ms,
            turn.speaker_id,
            turn.confidence,
            turn.boundary_speaker_id or turn.speaker_id,
            True,
            True,
        )
        for turn in turns
    ]


def _prototype(matrix: np.ndarray, weights: list[float], members: tuple[int, ...]) -> np.ndarray:
    values = matrix[list(members)]
    member_weights = np.asarray([weights[index] for index in members], dtype=np.float64)
    centroid = np.average(values, axis=0, weights=member_weights)
    return _unit_vector(centroid, required=True)


def _prototype_from_global(
    vectors: list[np.ndarray | None], weights: list[float], members: list[int]
) -> np.ndarray:
    matrix = np.vstack([vectors[index] for index in members])
    centroid = np.average(matrix, axis=0, weights=[weights[index] for index in members])
    return _unit_vector(centroid, required=True)


def _unit_vector(vector: np.ndarray | None, *, required: bool = False) -> np.ndarray | None:
    if vector is None:
        if required:
            raise ValueError("A prototype requires a finite embedding.")
        return None
    value = np.asarray(vector, dtype=np.float64).reshape(-1)
    norm = float(np.linalg.norm(value))
    if value.size == 0 or not np.all(np.isfinite(value)) or norm <= 1e-9:
        if required:
            raise ValueError("A prototype requires a finite embedding.")
        return None
    return value / norm


def _canonicalize(assignment: list[int]) -> list[int]:
    mapping: dict[int, int] = {}
    return [mapping.setdefault(value, len(mapping)) for value in assignment]


def _same_partition(left: list[str], right: list[str]) -> bool:
    if len(left) != len(right):
        return False
    return all(
        (left[a] == left[b]) == (right[a] == right[b])
        for a in range(len(left))
        for b in range(a + 1, len(left))
    )


def _weighted_average(values: list[float], weights: list[float]) -> float:
    return float(np.average(np.asarray(values), weights=np.asarray(weights)))


def _ordered_pair(left: int, right: int) -> tuple[int, int]:
    return (left, right) if left < right else (right, left)
