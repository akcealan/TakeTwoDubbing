from __future__ import annotations

import logging
import shutil
import tempfile
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from .models import CancelledError
from .schemas import EditableDraft, Job, JobStage

LOGGER = logging.getLogger(__name__)


class Engine(Protocol):
    def run(
        self,
        source: Path,
        duration_ms: int,
        progress: Callable[[JobStage], None],
        cancel: threading.Event,
        expected_speaker_count: int | None = None,
    ) -> EditableDraft: ...


class JobManager:
    def __init__(self, engine: Engine):
        self.engine = engine
        self._jobs: dict[str, Job] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="take-two-ai")

    def create(
        self,
        payload: bytes,
        suffix: str,
        duration_ms: int,
        expected_speaker_count: int | None = None,
    ) -> Job:
        job_id = str(uuid4())
        folder = Path(tempfile.mkdtemp(prefix="take-two-ai-"))
        source = folder / f"source{suffix}"
        source.write_bytes(payload)
        job = Job(id=job_id, status="queued", stage="queued")
        with self._lock:
            self._jobs[job_id] = job
            self._cancel[job_id] = threading.Event()
        self._executor.submit(
            self._run, job_id, source, duration_ms, expected_speaker_count, folder
        )
        return job.model_copy(deep=True)

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def cancel(self, job_id: str) -> Job | None:
        with self._lock:
            event = self._cancel.get(job_id)
            job = self._jobs.get(job_id)
            if event is None or job is None:
                return None
            event.set()
            if job.status == "queued":
                job.status = "cancelled"
            return job.model_copy(deep=True)

    def _run(
        self,
        job_id: str,
        source: Path,
        duration_ms: int,
        expected_speaker_count: int | None,
        folder: Path,
    ) -> None:
        try:
            with self._lock:
                job = self._jobs[job_id]
                event = self._cancel[job_id]
                if event.is_set():
                    job.status = "cancelled"
                    return
                job.status = "running"

            def progress(stage: JobStage) -> None:
                with self._lock:
                    self._jobs[job_id].stage = stage

            result = self.engine.run(source, duration_ms, progress, event, expected_speaker_count)
            with self._lock:
                job = self._jobs[job_id]
                if event.is_set():
                    job.status = "cancelled"
                else:
                    job.status = "succeeded"
                    job.result = result
        except CancelledError:
            with self._lock:
                self._jobs[job_id].status = "cancelled"
        except Exception as error:
            LOGGER.exception("Local AI job %s failed", job_id)
            with self._lock:
                job = self._jobs[job_id]
                job.status = "failed"
                job.error = _turkish_error(error)
        finally:
            shutil.rmtree(folder, ignore_errors=True)


def _turkish_error(error: Exception) -> str:
    text = str(error)
    if "gated repo" in text.lower() or "401" in text or "token" in text.lower():
        return "Diarization modeli için ücretsiz Hugging Face erişimi hazır değil. Model kurulumunu kontrol et."
    if "cuda" in text.lower() or "cudnn" in text.lower() or "cublas" in text.lower():
        return "CUDA başlatılamadı. CPU modunu kullan veya yerel CUDA kurulumunu kontrol et."
    if text.startswith(("Kaynak", "Video")):
        return text
    return "Yerel AI analizi tamamlanamadı. Servis terminalindeki ayrıntıları kontrol et."
