from __future__ import annotations

import hashlib
import json
import os
import random
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import av
import numpy as np

from .config import AI_ROOT, Settings
from .models import CancelledError
from .separation import decode_stereo_audio, mix_background

PROVIDER = "local-cinematic-separator"
PROVIDER_VERSION = "1"
MODEL = "CDX23 DnR checkpoint B"
CHECKPOINT_FILENAME = "97d170e1-dbb4db15.th"
CHECKPOINT_SHA256 = "dbb4db154df7e45a5cb72d1659c48937e757f6d6b0eef8ca4199e6e38f8d8f37"
SAMPLE_RATE = 44_100
CHANNELS = 2
AAC_BIT_RATE = 192_000
SHIFTS = 1
OVERLAP = 0.8

ProductProgress = Callable[[str], None]


@dataclass(frozen=True)
class ProductSeparationResult:
    mime_type: str
    byte_size: int
    duration_ms: int
    sample_rate: int
    channels: int
    provider: str
    provider_version: str
    model: str
    device: str
    inference_seconds: float
    warnings: list[str]

    def to_json_dict(self) -> dict[str, object]:
        return asdict(self)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checkpoint_status(settings: Settings) -> tuple[str, str | None]:
    checkpoint = settings.model_cache / "cdx23" / CHECKPOINT_FILENAME
    if not checkpoint.is_file():
        return "missing", None
    actual = sha256_file(checkpoint)
    return ("ready", actual) if actual == CHECKPOINT_SHA256 else ("invalid", actual)


def separation_python(requested_device: str) -> Path | None:
    configured = os.getenv("TAKETWO_SEPARATION_PYTHON")
    if configured:
        candidate = Path(configured).resolve()
        return candidate if candidate.is_file() else None
    names = (
        (".venv-separation-cuda", ".venv-separation")
        if requested_device in {"auto", "cuda"}
        else (".venv-separation", ".venv-separation-cuda")
    )
    for name in names:
        candidate = AI_ROOT / name / "Scripts" / "python.exe"
        if candidate.is_file():
            return candidate
    return None


def encode_background_m4a(path: Path, samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    audio = np.ascontiguousarray(samples, dtype=np.float32)
    if audio.ndim != 2 or audio.shape[0] != CHANNELS:
        raise ValueError("Background audio must be planar stereo.")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with av.open(
            str(path), mode="w", format="mp4", options={"movflags": "+faststart"}
        ) as output:
            stream = output.add_stream("aac", rate=sample_rate)
            stream.bit_rate = AAC_BIT_RATE
            stream.layout = "stereo"
            frame_size = 1024
            pts = 0
            for start in range(0, audio.shape[1], frame_size):
                frame = av.AudioFrame.from_ndarray(
                    audio[:, start : start + frame_size], format="fltp", layout="stereo"
                )
                frame.sample_rate = sample_rate
                frame.pts = pts
                pts += frame.samples
                for packet in stream.encode(frame):
                    output.mux(packet)
            for packet in stream.encode(None):
                output.mux(packet)
    except (av.error.FFmpegError, OSError) as error:
        raise RuntimeError("Sıkıştırılmış arka plan sesi kodlanamadı.") from error


def validate_compressed_background(path: Path, expected_samples: int) -> tuple[int, int, int]:
    sample_count = 0
    first_time: float | None = None
    try:
        with av.open(str(path)) as container:
            stream = next((item for item in container.streams if item.type == "audio"), None)
            if stream is None:
                raise RuntimeError("Kodlanan arka planda ses akışı yok.")
            sample_rate = int(stream.codec_context.sample_rate or 0)
            channels = int(stream.codec_context.channels or 0)
            for frame in container.decode(stream):
                if first_time is None and frame.pts is not None and frame.time_base is not None:
                    first_time = float(frame.pts * frame.time_base)
                sample_count += frame.samples
    except (av.error.FFmpegError, EOFError, OSError) as error:
        raise RuntimeError("Kodlanan arka plan sesi doğrulanamadı.") from error
    if sample_rate != SAMPLE_RATE or channels != CHANNELS:
        raise RuntimeError("Kodlanan arka plan 44.1 kHz stereo değil.")
    if first_time is not None and abs(first_time) > 1 / SAMPLE_RATE:
        raise RuntimeError("Kodlanan arka plan sahne zamanında sıfırdan başlamıyor.")
    if abs(sample_count - expected_samples) > 1024:
        raise RuntimeError("Kodlanan arka plan süresi kaynak sahneyle eşleşmiyor.")
    return sample_count, sample_rate, channels


def run_cdx23_product(
    source: Path,
    output: Path,
    requested_device: str,
    settings: Settings,
    progress: ProductProgress,
    cancel: threading.Event | None = None,
) -> ProductSeparationResult:
    cancel = cancel or threading.Event()
    checkpoint = settings.model_cache / "cdx23" / CHECKPOINT_FILENAME
    status, actual_sha = checkpoint_status(settings)
    if status == "missing":
        raise RuntimeError("Gerekli yerel ayırma modeli bulunamadı.")
    if status == "invalid":
        raise RuntimeError(f"Yerel ayırma modelinin checksum değeri geçersiz: {actual_sha}")
    if cancel.is_set():
        raise CancelledError()

    try:
        import torch
        from demucs_infer.apply import apply_model
        from demucs_infer.states import load_model
    except ImportError as error:
        raise RuntimeError("Yerel sinematik ayırma ortamı kurulu değil.") from error

    prepared = decode_stereo_audio(source, sample_rate=SAMPLE_RATE)
    progress("loading_model")
    model = load_model(checkpoint)
    if list(model.sources) != ["music", "sfx", "speech"]:
        raise RuntimeError("Yerel ayırıcı beklenen stem sözleşmesini sağlamıyor.")
    if model.samplerate != SAMPLE_RATE or model.audio_channels != CHANNELS:
        raise RuntimeError("Yerel ayırıcı beklenen ses biçimini sağlamıyor.")
    if requested_device not in {"auto", "cpu", "cuda"}:
        raise ValueError("requested device must be auto, cpu, or cuda")
    cuda_ready = bool(torch.cuda.is_available())
    if requested_device == "cuda" and not cuda_ready:
        raise RuntimeError("CUDA istendi ancak yerel ayırma ortamında kullanılamıyor.")
    device = "cuda" if requested_device == "auto" and cuda_ready else requested_device
    if device == "auto":
        device = "cpu"
    warnings: list[str] = []

    def infer(selected: str):
        if cancel.is_set():
            raise CancelledError()
        progress("separating")
        random.seed(0)
        mixture = torch.from_numpy(prepared.samples).unsqueeze(0)
        started = time.perf_counter()
        separated = apply_model(
            model,
            mixture,
            shifts=SHIFTS,
            split=True,
            overlap=OVERLAP,
            device=selected,
            num_workers=0,
        )[0].cpu()
        if selected == "cuda":
            torch.cuda.synchronize()
        return separated, time.perf_counter() - started

    try:
        separated, inference_seconds = infer(device)
    except RuntimeError as error:
        text = str(error).lower()
        if (
            requested_device == "auto"
            and device == "cuda"
            and "cuda" in text
            and ("out of memory" in text or "memory allocation" in text)
        ):
            warnings.append("CUDA belleği yetmedi; ayırma CPU üzerinde baştan çalıştırıldı.")
            torch.cuda.empty_cache()
            device = "cpu"
            separated, inference_seconds = infer(device)
        else:
            raise
    if cancel.is_set():
        raise CancelledError()
    stems = {
        name: np.ascontiguousarray(separated[index].numpy(), dtype=np.float32)
        for index, name in enumerate(("music", "effects", "speech"))
    }
    expected = prepared.samples.shape
    if any(value.shape != expected or not np.isfinite(value).all() for value in stems.values()):
        raise RuntimeError("Yerel ayırıcı geçersiz stem üretti.")
    background = mix_background(stems)
    progress("encoding")
    partial = output.with_suffix(".partial.m4a")
    try:
        encode_background_m4a(partial, background, SAMPLE_RATE)
        decoded_samples, sample_rate, channels = validate_compressed_background(
            partial, prepared.sample_count
        )
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)
    return ProductSeparationResult(
        mime_type="audio/mp4",
        byte_size=output.stat().st_size,
        duration_ms=round(decoded_samples * 1000 / sample_rate),
        sample_rate=sample_rate,
        channels=channels,
        provider=PROVIDER,
        provider_version=PROVIDER_VERSION,
        model=MODEL,
        device=device,
        inference_seconds=inference_seconds,
        warnings=warnings,
    )


def run_separation_subprocess(
    source: Path,
    output: Path,
    metadata_path: Path,
    requested_device: str,
    progress: ProductProgress,
    cancel: threading.Event,
) -> ProductSeparationResult:
    executable = separation_python(requested_device)
    if executable is None:
        raise RuntimeError("Yerel sinematik ayırma ortamı bulunamadı.")
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(AI_ROOT / "src")
    process = subprocess.Popen(
        [
            str(executable),
            "-m",
            "take_two_ai.cinematic_worker",
            str(source),
            str(output),
            str(metadata_path),
            requested_device,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def read_stdout() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            line = line.rstrip()
            stdout_lines.append(line)
            if line.startswith("STAGE:"):
                progress(line.removeprefix("STAGE:").strip())

    def read_stderr() -> None:
        assert process.stderr is not None
        stderr_lines.extend(line.rstrip() for line in process.stderr)

    stdout_thread = threading.Thread(target=read_stdout, name="separation-stdout", daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, name="separation-stderr", daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    try:
        while process.poll() is None:
            if cancel.wait(0.1):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                raise CancelledError()
        stdout_thread.join(timeout=2)
        stderr_thread.join(timeout=2)
    finally:
        if process.poll() is None:
            process.kill()
    if process.returncode != 0:
        detail = stderr_lines[-1] if stderr_lines else ""
        raise RuntimeError(detail or "Yerel sinematik ayırma tamamlanamadı.")
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        return ProductSeparationResult(**payload)
    except (OSError, TypeError, ValueError) as error:
        raise RuntimeError("Yerel ayırma sonucu doğrulanamadı.") from error
