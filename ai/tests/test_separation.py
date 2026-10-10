from __future__ import annotations

import sys
import threading
from pathlib import Path

import av
import numpy as np
import pytest

from take_two_ai.config import Settings
from take_two_ai.models import CancelledError
from take_two_ai.separation import (
    SeparationError,
    UnsafeEvaluationPathError,
    _bandit_session,
    _separate_chunked,
    choose_device,
    chunk_ranges,
    decode_stereo_audio,
    mix_background,
    separate_cinematic_audio,
    write_float_wav,
)


class FakeSession:
    spec = object()

    def __init__(self, *, oom: bool = False):
        self.oom = oom
        self.closed = False

    def load(self):
        return self

    def infer(self, audio: np.ndarray, *, sample_rate: int) -> dict[str, np.ndarray]:
        assert sample_rate == 48_000
        if self.oom:
            raise RuntimeError("CUDA out of memory")
        return {
            "speech": audio * np.float32(0.5),
            "music": audio * np.float32(0.3),
            "effects": audio * np.float32(0.2),
        }

    def close(self) -> None:
        self.closed = True


def sine_stereo(seconds: float, sample_rate: int = 48_000) -> np.ndarray:
    t = np.arange(round(seconds * sample_rate), dtype=np.float32) / sample_rate
    return np.stack((0.2 * np.sin(2 * np.pi * 220 * t), 0.1 * np.sin(2 * np.pi * 330 * t)))


def test_decode_stereo_audio_resamples_and_preserves_duration(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    write_float_wav(source, sine_stereo(0.25, 44_100), 44_100)

    prepared = decode_stereo_audio(source)

    assert prepared.sample_rate == 48_000
    assert prepared.source_channels == 2
    assert prepared.samples.shape == (2, 12_000)
    assert prepared.duration_seconds == pytest.approx(0.25)


def test_background_is_exact_music_plus_effects_without_normalization() -> None:
    stems = {
        "music": np.array([[0.8, -0.8]], dtype=np.float32),
        "effects": np.array([[0.5, -0.5]], dtype=np.float32),
    }
    assert np.array_equal(mix_background(stems), np.array([[1.3, -1.3]], dtype=np.float32))


def test_chunk_ranges_and_crossfade_preserve_boundaries() -> None:
    audio = sine_stereo(2.6, sample_rate=100)
    ranges = chunk_ranges(audio.shape[1], 100, chunk_seconds=1.0, overlap_seconds=0.2)
    progress: list[tuple[str, int, int]] = []

    stems = _separate_chunked(
        FakeSession(),
        audio,
        48_000,
        ranges,
        threading.Event(),
        lambda *event: progress.append(event),
    )

    assert ranges == [(0, 100), (80, 180), (160, 260)]
    assert np.allclose(stems["speech"], audio * 0.5, atol=1e-7)
    assert np.allclose(stems["music"] + stems["effects"], audio * 0.5, atol=1e-7)
    assert progress[-1] == ("infer", 3, 3)


def test_device_selection_is_explicit() -> None:
    assert choose_device("auto", cuda_available=True) == "cuda"
    assert choose_device("auto", cuda_available=False) == "cpu"
    assert choose_device("cpu", cuda_available=True) == "cpu"
    with pytest.raises(SeparationError, match="CUDA istendi"):
        choose_device("cuda", cuda_available=False)


def test_cancelled_before_decode_writes_nothing(tmp_path: Path) -> None:
    private = tmp_path / "private"
    private.mkdir()
    source = private / "source.wav"
    write_float_wav(source, sine_stereo(0.1), 48_000)
    output = private / "output"
    cancel = threading.Event()
    cancel.set()

    with pytest.raises(CancelledError):
        separate_cinematic_audio(
            source,
            output,
            private_root=private,
            cancel=cancel,
            session_factory=lambda *_: FakeSession(),
            cuda_available=False,
            settings=Settings(cache_dir=private / "cache"),
        )
    assert not output.exists()


def test_private_paths_are_enforced(tmp_path: Path) -> None:
    private = tmp_path / "private"
    private.mkdir()
    outside = tmp_path / "outside.wav"
    write_float_wav(outside, sine_stereo(0.1), 48_000)

    with pytest.raises(UnsafeEvaluationPathError, match="source"):
        separate_cinematic_audio(
            outside,
            private / "output",
            private_root=private,
            session_factory=lambda *_: FakeSession(),
            cuda_available=False,
            settings=Settings(cache_dir=private / "cache"),
        )


def test_outputs_duration_reconstruction_and_float_wav(tmp_path: Path) -> None:
    private = tmp_path / "private"
    private.mkdir()
    source = private / "source.wav"
    original = sine_stereo(0.3)
    write_float_wav(source, original, 48_000)

    result = separate_cinematic_audio(
        source,
        private / "output",
        private_root=private,
        requested_device="cpu",
        outer_chunk_seconds=0.12,
        outer_overlap_seconds=0.02,
        session_factory=lambda *_: FakeSession(),
        cuda_available=False,
        settings=Settings(cache_dir=private / "cache"),
    )

    assert result.diagnostics.channels == 2
    assert result.diagnostics.sample_count == 14_400
    assert result.diagnostics.reconstruction.relative_l2 < 1e-6
    assert result.diagnostics.output_sizes["background-music-plus-effects.wav"] > 0
    assert decode_stereo_audio(result.background).sample_count == 14_400
    assert result.diagnostics.signals["backgroundMusicPlusEffects"].peak == pytest.approx(
        result.diagnostics.signals["speech"].peak, rel=1e-5
    )


def test_cuda_oom_restarts_on_cpu_and_records_fallback(tmp_path: Path) -> None:
    private = tmp_path / "private"
    private.mkdir()
    source = private / "source.wav"
    write_float_wav(source, sine_stereo(0.1), 48_000)
    requested: list[str] = []

    def factory(device: str, _weights: Path) -> FakeSession:
        requested.append(device)
        return FakeSession(oom=device == "cuda")

    result = separate_cinematic_audio(
        source,
        private / "output",
        private_root=private,
        requested_device="auto",
        session_factory=factory,
        cuda_available=True,
        settings=Settings(cache_dir=private / "cache"),
    )

    assert requested == ["cuda", "cpu"]
    assert result.diagnostics.device_used == "cpu"
    assert result.diagnostics.cpu_fallback_used is True
    assert result.diagnostics.attempted_devices == ["cuda", "cpu"]
    assert "CPU" in result.diagnostics.warnings[0]


def test_malformed_stem_is_reported(tmp_path: Path) -> None:
    class BrokenSession(FakeSession):
        def infer(self, audio: np.ndarray, *, sample_rate: int) -> dict[str, np.ndarray]:
            return {"speech": audio, "music": audio}

    audio = sine_stereo(0.1)
    with pytest.raises(SeparationError, match="effects"):
        _separate_chunked(
            BrokenSession(),
            audio,
            48_000,
            [(0, audio.shape[1])],
            threading.Event(),
            None,
        )


def test_missing_inference_package_is_reported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setitem(sys.modules, "bandit_infer", None)
    with pytest.raises(SeparationError, match="paketi kurulu değil"):
        _bandit_session("cpu", tmp_path)


def test_written_wav_is_stereo_float_and_lossless(tmp_path: Path) -> None:
    path = tmp_path / "float.wav"
    audio = sine_stereo(0.05)
    write_float_wav(path, audio, 48_000)
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        assert stream.codec_context.name == "pcm_f32le"
        assert stream.codec_context.channels == 2
        assert stream.codec_context.sample_rate == 48_000
    decoded = decode_stereo_audio(path).samples
    assert np.array_equal(decoded, audio)
