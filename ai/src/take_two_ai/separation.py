from __future__ import annotations

import ctypes
import math
import os
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol
from uuid import uuid4

import av
import numpy as np

from .config import Settings, configure_private_caches
from .models import CancelledError

BANDIT_MODEL = "v2-multi"
BANDIT_NATIVE_SAMPLE_RATE = 48_000
BANDIT_CHECKPOINT_FILENAME = "checkpoint-multi.ckpt"
BANDIT_CHECKPOINT_BYTES = 446_680_129
BANDIT_CHECKPOINT_SHA256 = "abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc"
BANDIT_WEIGHT_URL = "https://zenodo.org/api/records/12701995/files/checkpoint-multi.ckpt/content"
BANDIT_WEIGHT_LICENSE = "CC-BY-SA-4.0"
BANDIT_CODE_LICENSE = "Apache-2.0"
BANDIT_INFER_REVISION = "d45cdec634bf1ee01cdd2acea74a2d100e639c8a"
DEFAULT_OUTER_CHUNK_SECONDS = 24.0
DEFAULT_OUTER_OVERLAP_SECONDS = 2.0


class SeparationError(RuntimeError):
    pass


class SeparationModelMissingError(SeparationError):
    pass


class UnsafeEvaluationPathError(SeparationError):
    pass


class SeparationSession(Protocol):
    spec: object

    def load(self) -> SeparationSession: ...

    def infer(self, audio: np.ndarray, *, sample_rate: int) -> dict[str, np.ndarray]: ...

    def close(self) -> None: ...


SessionFactory = Callable[[str, Path], SeparationSession]
ProgressCallback = Callable[[str, int, int], None]


@dataclass(frozen=True)
class PreparedAudio:
    samples: np.ndarray
    sample_rate: int
    source_channels: int

    @property
    def channels(self) -> int:
        return int(self.samples.shape[0])

    @property
    def sample_count(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration_seconds(self) -> float:
        return self.sample_count / self.sample_rate


@dataclass(frozen=True)
class SignalMetrics:
    peak: float
    rms: float


@dataclass(frozen=True)
class ReconstructionMetrics:
    residual_peak: float
    residual_rms: float
    relative_l2: float


@dataclass
class SeparationDiagnostics:
    model: str
    requested_device: str
    device_used: str
    attempted_devices: list[str]
    cpu_fallback_used: bool
    sample_rate: int
    channels: int
    sample_count: int
    duration_seconds: float
    outer_chunk_seconds: float
    outer_overlap_seconds: float
    outer_chunk_count: int
    inner_chunk_seconds: float
    inner_hop_seconds: float
    model_load_seconds: float
    inference_seconds: float
    total_seconds: float
    realtime_factor: float
    peak_vram_allocated_bytes: int | None
    peak_vram_reserved_bytes: int | None
    peak_process_ram_bytes: int | None
    signals: dict[str, SignalMetrics]
    reconstruction: ReconstructionMetrics
    output_sizes: dict[str, int]
    warnings: list[str]

    def to_json_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class SeparationResult:
    output_dir: Path
    original_reference: Path
    speech: Path
    music: Path
    effects: Path
    background: Path
    diagnostics: SeparationDiagnostics


def decode_stereo_audio(
    source: Path, *, sample_rate: int = BANDIT_NATIVE_SAMPLE_RATE
) -> PreparedAudio:
    """Decode locally through PyAV and preserve or create a stereo pair at 48 kHz."""
    frames: list[np.ndarray] = []
    try:
        with av.open(str(source)) as container:
            stream = next((item for item in container.streams if item.type == "audio"), None)
            if stream is None:
                raise SeparationError("Kaynak klipte ayrıştırılabilir bir ses kanalı yok.")
            source_channels = int(stream.codec_context.channels or 0)
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=sample_rate)
            for frame in container.decode(stream):
                for converted in resampler.resample(frame):
                    frames.append(_planar_float(converted))
            for converted in resampler.resample(None):
                frames.append(_planar_float(converted))
    except SeparationError:
        raise
    except (av.error.FFmpegError, EOFError, OSError, StopIteration) as error:
        raise SeparationError("Video veya ses dosyası yerel olarak çözümlenemedi.") from error
    if not frames:
        raise SeparationError("Kaynak klipte ayrıştırılabilir ses bulunamadı.")
    samples = np.ascontiguousarray(np.concatenate(frames, axis=1), dtype=np.float32)
    return PreparedAudio(samples, sample_rate, source_channels)


def _planar_float(frame: av.AudioFrame) -> np.ndarray:
    values = np.asarray(frame.to_ndarray(), dtype=np.float32)
    if values.ndim != 2 or values.shape[0] != 2:
        raise SeparationError("48 kHz stereo ses hazırlığı beklenmeyen kanal düzeni üretti.")
    return values


def write_float_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """Write lossless IEEE float WAV without per-stem normalization or gain changes."""
    audio = np.ascontiguousarray(samples, dtype=np.float32)
    if audio.ndim != 2 or audio.shape[0] not in (1, 2):
        raise ValueError("WAV samples must have shape (channels, samples)")
    layout = "mono" if audio.shape[0] == 1 else "stereo"
    path.parent.mkdir(parents=True, exist_ok=True)
    with av.open(str(path), mode="w", format="wav") as container:
        stream = container.add_stream("pcm_f32le", rate=sample_rate)
        stream.layout = layout
        frame_size = 65_536
        pts = 0
        for start in range(0, audio.shape[1], frame_size):
            frame = av.AudioFrame.from_ndarray(
                audio[:, start : start + frame_size], format="fltp", layout=layout
            )
            frame.sample_rate = sample_rate
            frame.pts = pts
            pts += frame.samples
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)


def choose_device(requested: str, *, cuda_available: bool | None = None) -> str:
    normalized = requested.lower()
    if normalized not in {"auto", "cpu", "cuda"}:
        raise ValueError("device must be auto, cpu, or cuda")
    if cuda_available is None:
        try:
            import torch

            cuda_available = bool(torch.cuda.is_available())
        except ImportError:
            cuda_available = False
    if normalized == "cuda" and not cuda_available:
        raise SeparationError("CUDA istendi ancak bu ayrıştırma ortamında kullanılamıyor.")
    if normalized == "auto":
        return "cuda" if cuda_available else "cpu"
    return normalized


def chunk_ranges(
    sample_count: int,
    sample_rate: int,
    chunk_seconds: float = DEFAULT_OUTER_CHUNK_SECONDS,
    overlap_seconds: float = DEFAULT_OUTER_OVERLAP_SECONDS,
) -> list[tuple[int, int]]:
    chunk = max(1, round(chunk_seconds * sample_rate))
    overlap = max(0, round(overlap_seconds * sample_rate))
    if overlap >= chunk:
        raise ValueError("outer overlap must be shorter than the outer chunk")
    if sample_count <= chunk:
        return [(0, sample_count)]
    step = chunk - overlap
    ranges: list[tuple[int, int]] = []
    start = 0
    while start < sample_count:
        end = min(sample_count, start + chunk)
        ranges.append((start, end))
        if end == sample_count:
            break
        start += step
    return ranges


def mix_background(stems: dict[str, np.ndarray]) -> np.ndarray:
    try:
        music = stems["music"]
        effects = stems["effects"]
    except KeyError as error:
        raise SeparationError(
            "Ayrıştırıcı music ve effects stemlerini birlikte döndürmedi."
        ) from error
    if music.shape != effects.shape:
        raise SeparationError("Music ve effects stem boyutları eşleşmiyor.")
    return np.asarray(music + effects, dtype=np.float32)


def reconstruct(stems: dict[str, np.ndarray]) -> np.ndarray:
    try:
        return np.asarray(stems["speech"] + stems["music"] + stems["effects"], dtype=np.float32)
    except KeyError as error:
        raise SeparationError("Ayrıştırıcı beklenen üç stemin tamamını döndürmedi.") from error


def separate_cinematic_audio(
    source: Path,
    output_dir: Path,
    *,
    private_root: Path,
    requested_device: str = "auto",
    outer_chunk_seconds: float = DEFAULT_OUTER_CHUNK_SECONDS,
    outer_overlap_seconds: float = DEFAULT_OUTER_OVERLAP_SECONDS,
    allow_cpu_fallback: bool = True,
    cancel: threading.Event | None = None,
    progress: ProgressCallback | None = None,
    settings: Settings | None = None,
    session_factory: SessionFactory | None = None,
    cuda_available: bool | None = None,
) -> SeparationResult:
    """Run local Bandit v2 Multi and create an atomic, private listening handoff."""
    started = time.perf_counter()
    cancel = cancel or threading.Event()
    current = settings or Settings()
    configure_private_caches(current, offline=True)
    source = source.resolve()
    output_dir = output_dir.resolve()
    private_root = private_root.resolve()
    _require_private_path(source, private_root, "source")
    _require_private_path(output_dir, private_root, "output")
    if output_dir.exists():
        raise FileExistsError(f"Evaluation output already exists: {output_dir}")
    _check_cancel(cancel)
    _emit(progress, "prepare", 0, 1)
    prepared = decode_stereo_audio(source)
    _emit(progress, "prepare", 1, 1)
    _check_cancel(cancel)

    selected = choose_device(requested_device, cuda_available=cuda_available)
    attempts = [selected]
    warnings: list[str] = []
    peak_vram_allocated: int | None = None
    peak_vram_reserved: int | None = None
    load_seconds = 0.0
    inference_seconds = 0.0
    ranges = chunk_ranges(
        prepared.sample_count,
        prepared.sample_rate,
        outer_chunk_seconds,
        outer_overlap_seconds,
    )
    memory = _MemorySampler()
    memory.start()
    try:
        try:
            stems, load_seconds, inference_seconds, gpu_metrics = _run_device(
                prepared,
                ranges,
                selected,
                current.separation_model_cache,
                cancel,
                progress,
                session_factory,
            )
            peak_vram_allocated, peak_vram_reserved = gpu_metrics
        except RuntimeError as error:
            if (
                requested_device != "auto"
                or selected != "cuda"
                or not allow_cpu_fallback
                or not _is_cuda_oom(error)
            ):
                raise
            warnings.append(
                "CUDA bellek yetersizliği oluştu; ayrıştırma baştan ve açıkça CPU üzerinde tekrarlandı."
            )
            attempts.append("cpu")
            _release_cuda()
            stems, cpu_load, cpu_inference, gpu_metrics = _run_device(
                prepared,
                ranges,
                "cpu",
                current.separation_model_cache,
                cancel,
                progress,
                session_factory,
            )
            load_seconds += cpu_load
            inference_seconds += cpu_inference
            selected = "cpu"
            peak_vram_allocated, peak_vram_reserved = gpu_metrics
    finally:
        memory.stop()
    _validate_stems(stems, prepared.samples.shape)
    background = mix_background(stems)
    reconstruction_audio = reconstruct(stems)
    residual = prepared.samples - reconstruction_audio
    reconstruction_metrics = ReconstructionMetrics(
        residual_peak=_peak(residual),
        residual_rms=_rms(residual),
        relative_l2=_relative_l2(residual, prepared.samples),
    )
    signals = {
        "original": _signal_metrics(prepared.samples),
        "speech": _signal_metrics(stems["speech"]),
        "music": _signal_metrics(stems["music"]),
        "effects": _signal_metrics(stems["effects"]),
        "backgroundMusicPlusEffects": _signal_metrics(background),
    }

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = output_dir.parent / f".{output_dir.name}.{uuid4().hex}.partial"
    paths = {
        "original-reference.wav": prepared.samples,
        "speech.wav": stems["speech"],
        "music.wav": stems["music"],
        "effects.wav": stems["effects"],
        "background-music-plus-effects.wav": background,
    }
    try:
        staging.mkdir()
        for index, (name, audio) in enumerate(paths.items(), start=1):
            _check_cancel(cancel)
            _emit(progress, "write", index - 1, len(paths))
            write_float_wav(staging / name, audio, prepared.sample_rate)
        _emit(progress, "write", len(paths), len(paths))
        staging.rename(output_dir)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    total_seconds = time.perf_counter() - started
    output_sizes = {name: (output_dir / name).stat().st_size for name in paths}
    diagnostics = SeparationDiagnostics(
        model=BANDIT_MODEL,
        requested_device=requested_device,
        device_used=selected,
        attempted_devices=attempts,
        cpu_fallback_used=len(attempts) > 1,
        sample_rate=prepared.sample_rate,
        channels=prepared.channels,
        sample_count=prepared.sample_count,
        duration_seconds=prepared.duration_seconds,
        outer_chunk_seconds=outer_chunk_seconds,
        outer_overlap_seconds=outer_overlap_seconds,
        outer_chunk_count=len(ranges),
        inner_chunk_seconds=8.0,
        inner_hop_seconds=1.0,
        model_load_seconds=load_seconds,
        inference_seconds=inference_seconds,
        total_seconds=total_seconds,
        realtime_factor=inference_seconds / prepared.duration_seconds,
        peak_vram_allocated_bytes=peak_vram_allocated,
        peak_vram_reserved_bytes=peak_vram_reserved,
        peak_process_ram_bytes=memory.peak_bytes,
        signals=signals,
        reconstruction=reconstruction_metrics,
        output_sizes=output_sizes,
        warnings=warnings,
    )
    return SeparationResult(
        output_dir=output_dir,
        original_reference=output_dir / "original-reference.wav",
        speech=output_dir / "speech.wav",
        music=output_dir / "music.wav",
        effects=output_dir / "effects.wav",
        background=output_dir / "background-music-plus-effects.wav",
        diagnostics=diagnostics,
    )


def _run_device(
    prepared: PreparedAudio,
    ranges: list[tuple[int, int]],
    device: str,
    weights_dir: Path,
    cancel: threading.Event,
    progress: ProgressCallback | None,
    factory: SessionFactory | None,
) -> tuple[dict[str, np.ndarray], float, float, tuple[int | None, int | None]]:
    _check_cancel(cancel)
    if device == "cuda":
        _reset_cuda_metrics()
    session = (factory or _bandit_session)(device, weights_dir)
    load_started = time.perf_counter()
    try:
        session.load()
    except Exception:
        session.close()
        raise
    load_seconds = time.perf_counter() - load_started
    try:
        inference_started = time.perf_counter()
        stems = _separate_chunked(
            session, prepared.samples, prepared.sample_rate, ranges, cancel, progress
        )
        inference_seconds = time.perf_counter() - inference_started
        if device == "cuda":
            gpu = _read_cuda_metrics()
        else:
            gpu = (None, None)
        return stems, load_seconds, inference_seconds, gpu
    finally:
        session.close()


def _bandit_session(device: str, weights_dir: Path) -> SeparationSession:
    try:
        from bandit_infer import BanditSession
    except ImportError as error:
        raise SeparationModelMissingError(
            "Bandit inference paketi kurulu değil; önce npm run ai:separation:setup çalıştır."
        ) from error
    probe = BanditSession(BANDIT_MODEL, device=device, weights_dir=weights_dir)
    info = probe.cache_info()
    if not info.get("verified"):
        raise SeparationModelMissingError(
            "Bandit v2 Multi ağırlığı eksik veya checksum geçersiz; "
            "npm run ai:separation:models çalıştır."
        )
    return BanditSession(
        BANDIT_MODEL,
        device=device,
        weights_dir=weights_dir,
        checkpoint_path=Path(str(info["path"])),
        checkpoint_sha256=BANDIT_CHECKPOINT_SHA256,
    )


def _separate_chunked(
    session: SeparationSession,
    audio: np.ndarray,
    sample_rate: int,
    ranges: list[tuple[int, int]],
    cancel: threading.Event,
    progress: ProgressCallback | None,
) -> dict[str, np.ndarray]:
    stems = {
        name: np.zeros_like(audio, dtype=np.float32) for name in ("speech", "music", "effects")
    }
    weights = np.zeros(audio.shape[1], dtype=np.float32)
    for index, (start, end) in enumerate(ranges):
        _check_cancel(cancel)
        _emit(progress, "infer", index, len(ranges))
        predicted = session.infer(audio[:, start:end], sample_rate=sample_rate)
        _check_cancel(cancel)
        expected = (audio.shape[0], end - start)
        _validate_stems(predicted, expected)
        window = _crossfade_window(ranges, index)
        weights[start:end] += window
        for name, stem in stems.items():
            stem[:, start:end] += predicted[name] * window[None, :]
    _emit(progress, "infer", len(ranges), len(ranges))
    if np.any(weights <= 0):
        raise SeparationError("Dış parça birleştirme ses zaman çizelgesinde boşluk bıraktı.")
    for name in stems:
        stems[name] /= weights[None, :]
    return stems


def _crossfade_window(ranges: list[tuple[int, int]], index: int) -> np.ndarray:
    start, end = ranges[index]
    window = np.ones(end - start, dtype=np.float32)
    if index > 0:
        previous_end = ranges[index - 1][1]
        overlap = max(0, previous_end - start)
        if overlap:
            phase = np.linspace(0.0, math.pi, overlap, endpoint=False, dtype=np.float32)
            window[:overlap] = 0.5 - 0.5 * np.cos(phase)
    if index + 1 < len(ranges):
        next_start = ranges[index + 1][0]
        overlap = max(0, end - next_start)
        if overlap:
            phase = np.linspace(0.0, math.pi, overlap, endpoint=False, dtype=np.float32)
            window[-overlap:] = 0.5 + 0.5 * np.cos(phase)
    return window


def _validate_stems(stems: dict[str, np.ndarray], expected: tuple[int, int]) -> None:
    for name in ("speech", "music", "effects"):
        value = stems.get(name)
        if value is None or value.shape != expected or not np.isfinite(value).all():
            raise SeparationError(f"{name} stem boyutu/geçerliliği beklenen sonucu vermedi.")


def _require_private_path(path: Path, root: Path, label: str) -> None:
    if path != root and not path.is_relative_to(root):
        raise UnsafeEvaluationPathError(f"{label} path must stay under {root}")


def _check_cancel(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise CancelledError()


def _emit(progress: ProgressCallback | None, stage: str, completed: int, total: int) -> None:
    if progress is not None:
        progress(stage, completed, total)


def _is_cuda_oom(error: RuntimeError) -> bool:
    text = str(error).lower()
    return "cuda" in text and ("out of memory" in text or "memory allocation" in text)


def _release_cuda() -> None:
    try:
        import torch

        torch.cuda.empty_cache()
    except (ImportError, RuntimeError):
        pass


def _reset_cuda_metrics() -> None:
    try:
        import torch

        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    except (AttributeError, ImportError, RuntimeError):
        pass


def _read_cuda_metrics() -> tuple[int | None, int | None]:
    try:
        import torch

        return int(torch.cuda.max_memory_allocated()), int(torch.cuda.max_memory_reserved())
    except (AttributeError, ImportError, RuntimeError):
        return None, None


def _peak(values: np.ndarray) -> float:
    return float(np.max(np.abs(values))) if values.size else 0.0


def _rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values, dtype=np.float64)))) if values.size else 0.0


def _relative_l2(residual: np.ndarray, reference: np.ndarray) -> float:
    denominator = float(np.linalg.norm(reference.astype(np.float64)))
    return float(np.linalg.norm(residual.astype(np.float64)) / denominator) if denominator else 0.0


def _signal_metrics(values: np.ndarray) -> SignalMetrics:
    return SignalMetrics(peak=_peak(values), rms=_rms(values))


class _MemorySampler:
    def __init__(self) -> None:
        self.peak_bytes: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._sample()
        self._thread = threading.Thread(target=self._run, name="separation-memory", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
        self._sample()

    def _run(self) -> None:
        while not self._stop.wait(0.05):
            self._sample()

    def _sample(self) -> None:
        current = _process_working_set_bytes()
        if current is not None:
            self.peak_bytes = max(self.peak_bytes or 0, current)


def _process_working_set_bytes() -> int | None:
    if os.name != "nt":
        return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ProcessMemoryCounters),
        ctypes.c_ulong,
    ]
    psapi.GetProcessMemoryInfo.restype = ctypes.c_int

    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    handle = kernel32.GetCurrentProcess()
    if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        return None
    return int(counters.WorkingSetSize)
