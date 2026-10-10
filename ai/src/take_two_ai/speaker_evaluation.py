from __future__ import annotations

from collections.abc import Sequence
from functools import cache
from typing import Any


def permutation_invariant_turn_metrics(
    reference: Sequence[str], hypothesis: Sequence[str]
) -> dict[str, Any]:
    """Evaluate identity grouping without assuming that arbitrary label names match."""
    if len(reference) != len(hypothesis):
        raise ValueError("Reference and hypothesis must contain the same number of turns.")
    reference_labels = sorted(set(reference))
    hypothesis_labels = sorted(set(hypothesis))
    counts = [
        [
            sum(
                1
                for expected, predicted in zip(reference, hypothesis, strict=True)
                if expected == reference_label and predicted == hypothesis_label
            )
            for reference_label in reference_labels
        ]
        for hypothesis_label in hypothesis_labels
    ]
    mapping, correct = _optimal_mapping(hypothesis_labels, reference_labels, counts)
    total = len(reference)
    fragmentation = sum(
        max(
            0,
            len(
                {
                    predicted
                    for expected, predicted in zip(reference, hypothesis, strict=True)
                    if expected == label
                }
            )
            - 1,
        )
        for label in reference_labels
    )
    contamination = sum(
        max(
            0,
            len(
                {
                    expected
                    for expected, predicted in zip(reference, hypothesis, strict=True)
                    if predicted == label
                }
            )
            - 1,
        )
        for label in hypothesis_labels
    )
    return {
        "trueSpeakerCount": len(reference_labels),
        "predictedSpeakerCount": len(hypothesis_labels),
        "turnCount": total,
        "turnAccuracy": correct / total if total else 1.0,
        "correctTurnCount": correct,
        "speakerFragmentationCount": fragmentation,
        "speakerContaminationCount": contamination,
        "optimalLabelMapping": mapping,
    }


def _optimal_mapping(
    hypotheses: list[str], references: list[str], counts: list[list[int]]
) -> tuple[dict[str, str], int]:
    if not hypotheses or not references:
        return {}, 0
    if len(references) > 16:
        return _greedy_mapping(hypotheses, references, counts)

    @cache
    def solve(row: int, used: int) -> tuple[int, tuple[int, ...]]:
        if row == len(hypotheses):
            return 0, ()
        options: list[tuple[int, tuple[int, ...]]] = []
        for column in range(len(references)):
            if used & (1 << column):
                continue
            score, suffix = solve(row + 1, used | (1 << column))
            options.append((counts[row][column] + score, (column,) + suffix))
        score, suffix = solve(row + 1, used)
        options.append((score, (-1,) + suffix))
        return max(options, key=lambda item: (item[0], tuple(-value for value in item[1])))

    correct, columns = solve(0, 0)
    mapping = {
        hypotheses[row]: references[column] for row, column in enumerate(columns) if column >= 0
    }
    return mapping, correct


def _greedy_mapping(
    hypotheses: list[str], references: list[str], counts: list[list[int]]
) -> tuple[dict[str, str], int]:
    edges = sorted(
        (-counts[row][column], hypotheses[row], references[column], row, column)
        for row in range(len(hypotheses))
        for column in range(len(references))
    )
    mapping: dict[str, str] = {}
    used_references: set[str] = set()
    correct = 0
    for negative_count, hypothesis, reference, _, _ in edges:
        if hypothesis in mapping or reference in used_references:
            continue
        mapping[hypothesis] = reference
        used_references.add(reference)
        correct -= negative_count
    return mapping, correct
