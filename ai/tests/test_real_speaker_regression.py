from __future__ import annotations

import os
import socket
import threading
import wave
from pathlib import Path

import numpy as np
import pytest
import torch

from take_two_ai.config import Settings, configure_private_caches
from take_two_ai.domain import DiarizationTurn
from take_two_ai.media import extract_mono_wav
from take_two_ai.models import LocalModelEngine, extract_turn_acoustic_evidence
from take_two_ai.speaker_evaluation import permutation_invariant_turn_metrics

PRIVATE_CLIP = Path(__file__).resolve().parents[2] / "local-test-media/clip1-speaker-regression.mp4"
RUN_REAL = os.getenv("TAKETWO_REAL_SPEAKER_REGRESSION") == "1"
pytestmark = pytest.mark.skipif(
    not RUN_REAL or not PRIVATE_CLIP.is_file(),
    reason="opt-in private local Community-1 regression",
)


def _deny_network(*_args, **_kwargs):
    raise RuntimeError("Network disabled for private speaker regression")


@pytest.mark.timeout(240)
def test_real_embedding_invariance_and_private_clip_modes(tmp_path, monkeypatch):
    monkeypatch.setattr(socket.socket, "connect", _deny_network)
    monkeypatch.setattr(socket, "create_connection", _deny_network)
    settings = Settings(device="cpu")
    configure_private_caches(settings, offline=True)
    wav_path = tmp_path / "private-regression.mono.wav"
    extract_mono_wav(PRIVATE_CLIP, wav_path)
    engine = LocalModelEngine(settings)
    cancel = threading.Event()

    automatic, automatic_diagnostics = engine._diarize(wav_path, None, cancel, include_vectors=True)
    exact, exact_diagnostics = engine._diarize(wav_path, 3, cancel, include_vectors=True)
    raw_automatic = [
        DiarizationTurn(item["startMs"], item["endMs"], item["speakerId"])
        for item in automatic_diagnostics["rawDiarizationTurns"]
    ]
    with wave.open(str(wav_path), "rb") as source:
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16)
        audio = {
            "waveform": torch.from_numpy(samples.astype(np.float32) / 32768.0).unsqueeze(0),
            "sample_rate": source.getframerate(),
        }

    target = raw_automatic[3]
    alone = extract_turn_acoustic_evidence(engine._diarization, audio, [target])[0]
    full = extract_turn_acoustic_evidence(engine._diarization, audio, raw_automatic)[3]
    reordered_turns = [raw_automatic[-1], target, raw_automatic[0], raw_automatic[6]]
    reordered = extract_turn_acoustic_evidence(engine._diarization, audio, reordered_turns)[1]
    assert alone.embedding is not None
    assert full.embedding is not None
    assert reordered.embedding is not None
    assert float(np.dot(alone.embedding, full.embedding)) > 0.99999
    assert float(np.dot(alone.embedding, reordered.embedding)) > 0.99999
    assert full.artificial_padding_samples == 0

    truth = ["A", "B", "A", "C", "B", "A", "B"]
    for turns in (automatic, exact):
        metrics = permutation_invariant_turn_metrics(truth, [turn.speaker_id for turn in turns[:7]])
        assert metrics["correctTurnCount"] == 7
    for diagnostics in (automatic_diagnostics, exact_diagnostics):
        decision = diagnostics["sceneSpeakerStabilization"]["turnIdentityDecisions"][3]
        assert decision["state"] == "novel"
