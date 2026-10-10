from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np

from take_two_ai.cinematic import (
    ProductSeparationResult,
    encode_background_m4a,
    validate_compressed_background,
)
from take_two_ai.models import CancelledError
from take_two_ai.separation_jobs import SeparationJobManager


def result(byte_size: int = 12) -> ProductSeparationResult:
    return ProductSeparationResult(
        mime_type="audio/mp4",
        byte_size=byte_size,
        duration_ms=1000,
        sample_rate=44_100,
        channels=2,
        provider="fixture-provider",
        provider_version="1",
        model="fixture-model",
        device="cpu",
        inference_seconds=0.01,
        warnings=[],
    )


def wait_for_terminal(manager: SeparationJobManager, job_id: str):
    for _ in range(100):
        job = manager.get(job_id)
        if job and job.status not in {"queued", "running"}:
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_aac_derivative_preserves_stereo_and_bounded_duration(tmp_path: Path) -> None:
    sample_count = 44_100 + 137
    time_axis = np.arange(sample_count, dtype=np.float32) / 44_100
    audio = np.stack(
        (
            0.1 * np.sin(2 * np.pi * 220 * time_axis),
            0.1 * np.sin(2 * np.pi * 330 * time_axis),
        )
    ).astype(np.float32)
    output = tmp_path / "background.m4a"

    encode_background_m4a(output, audio)
    decoded_samples, sample_rate, channels = validate_compressed_background(output, sample_count)

    assert output.read_bytes()[4:8] == b"ftyp"
    assert abs(decoded_samples - sample_count) <= 1024
    assert sample_rate == 44_100
    assert channels == 2


def test_product_job_uses_fixed_safe_names_and_retains_result_for_retry(tmp_path: Path) -> None:
    observed: dict[str, str] = {}

    def engine(source, output, metadata, requested_device, progress, cancel):
        observed.update(source=source.name, output=output.name, metadata=metadata.name)
        progress("loading_model")
        progress("separating")
        progress("encoding")
        output.write_bytes(b"\x00\x00\x00\x0cftypM4A ")
        return result(output.stat().st_size)

    manager = SeparationJobManager(engine)
    created = manager.create(bytes((0x1A, 0x45, 0xDF, 0xA3)), ".webm", "auto")
    finished = wait_for_terminal(manager, created.id)

    assert finished.status == "succeeded"
    assert finished.stage == "encoding"
    assert observed == {
        "source": "source.webm",
        "output": "background.m4a",
        "metadata": "result.json",
    }
    assert manager.result_path(created.id) is not None
    manager.cancel(created.id)
    assert manager.result_path(created.id) is None


def test_product_job_cancellation_does_not_publish_partial_output() -> None:
    started = threading.Event()

    def engine(source, output, metadata, requested_device, progress, cancel):
        started.set()
        while not cancel.wait(0.01):
            pass
        raise CancelledError()

    manager = SeparationJobManager(engine)
    created = manager.create(bytes((0x1A, 0x45, 0xDF, 0xA3)), ".webm", "cpu")
    assert started.wait(1)
    manager.cancel(created.id)
    cancelled = wait_for_terminal(manager, created.id)

    assert cancelled.status == "cancelled"
    assert manager.result_path(created.id) is None


def test_product_job_reports_encode_failure_and_can_retry() -> None:
    attempts = 0

    def engine(source, output, metadata, requested_device, progress, cancel):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("Sıkıştırılmış arka plan sesi kodlanamadı.")
        output.write_bytes(b"\x00\x00\x00\x0cftypM4A ")
        return result(output.stat().st_size)

    manager = SeparationJobManager(engine)
    failed = wait_for_terminal(
        manager,
        manager.create(bytes((0x1A, 0x45, 0xDF, 0xA3)), ".webm", "cpu").id,
    )
    succeeded = wait_for_terminal(
        manager,
        manager.create(bytes((0x1A, 0x45, 0xDF, 0xA3)), ".webm", "cpu").id,
    )

    assert failed.status == "failed"
    assert "kodlanamadı" in (failed.error or "")
    assert succeeded.status == "succeeded"
    manager.cancel(succeeded.id)


def test_product_result_expires_without_a_follow_up_request(tmp_path: Path) -> None:
    def engine(source, output, metadata, requested_device, progress, cancel):
        output.write_bytes(b"\x00\x00\x00\x0cftypM4A ")
        return result(output.stat().st_size)

    manager = SeparationJobManager(engine, temp_root=tmp_path, result_ttl_seconds=0.2)
    created = manager.create(bytes((0x1A, 0x45, 0xDF, 0xA3)), ".webm", "cpu")
    assert wait_for_terminal(manager, created.id).status == "succeeded"
    assert manager.result_path(created.id) is not None

    deadline = time.monotonic() + 1
    while manager.result_path(created.id) is not None and time.monotonic() < deadline:
        time.sleep(0.01)

    assert manager.result_path(created.id) is None
    assert not list(tmp_path.glob("take-two-separation-*"))
