from __future__ import annotations

import logging
import shutil
import tempfile
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from .cinematic import ProductSeparationResult, run_separation_subprocess
from .models import CancelledError
from .schemas import SeparationJob, SeparationResult

LOGGER = logging.getLogger(__name__)
RESULT_TTL_SECONDS = 30 * 60


class SeparationEngine(Protocol):
    def __call__(
        self,
        source: Path,
        output: Path,
        metadata: Path,
        requested_device: str,
        progress: Callable[[str], None],
        cancel: threading.Event,
    ) -> ProductSeparationResult: ...


class SeparationJobManager:
    def __init__(
        self,
        engine: SeparationEngine = run_separation_subprocess,
        *,
        temp_root: Path | None = None,
        result_ttl_seconds: float = RESULT_TTL_SECONDS,
    ):
        self.engine = engine
        self._temp_root = (temp_root or Path(tempfile.gettempdir())).resolve()
        self._temp_root.mkdir(parents=True, exist_ok=True)
        self._result_ttl_seconds = result_ttl_seconds
        self._jobs: dict[str, SeparationJob] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._folders: dict[str, Path] = {}
        self._completed_at: dict[str, float] = {}
        self._expiry_timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="take-two-separation")
        self._cleanup_orphaned_folders()

    def create(self, payload: bytes, suffix: str, requested_device: str) -> SeparationJob:
        self._cleanup_expired()
        job_id = str(uuid4())
        folder = Path(tempfile.mkdtemp(prefix="take-two-separation-", dir=self._temp_root))
        source = folder / f"source{suffix}"
        source.write_bytes(payload)
        job = SeparationJob(id=job_id, status="queued", stage="queued")
        with self._lock:
            self._jobs[job_id] = job
            self._cancel[job_id] = threading.Event()
            self._folders[job_id] = folder
        self._executor.submit(self._run, job_id, source, requested_device, folder)
        return job.model_copy(deep=True)

    def get(self, job_id: str) -> SeparationJob | None:
        self._cleanup_expired()
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def result_path(self, job_id: str) -> Path | None:
        with self._lock:
            job = self._jobs.get(job_id)
            folder = self._folders.get(job_id)
            if not job or job.status != "succeeded" or not folder:
                return None
            output = folder / "background.m4a"
            return output if output.is_file() else None

    def cancel(self, job_id: str) -> SeparationJob | None:
        with self._lock:
            event = self._cancel.get(job_id)
            job = self._jobs.get(job_id)
            if event is None or job is None:
                return None
            event.set()
            timer = self._expiry_timers.pop(job_id, None)
            if timer:
                timer.cancel()
            if job.status in {"queued", "succeeded", "failed", "cancelled"}:
                job.status = "cancelled"
                folder = self._folders.pop(job_id, None)
                self._completed_at[job_id] = time.monotonic()
                if folder:
                    shutil.rmtree(folder, ignore_errors=True)
            return job.model_copy(deep=True)

    def _run(self, job_id: str, source: Path, requested_device: str, folder: Path) -> None:
        retain = False
        expiry_timer: threading.Timer | None = None
        try:
            with self._lock:
                job = self._jobs[job_id]
                event = self._cancel[job_id]
                if event.is_set():
                    job.status = "cancelled"
                    return
                job.status = "running"

            def progress(stage: str) -> None:
                with self._lock:
                    if stage in {"loading_model", "separating", "encoding"}:
                        self._jobs[job_id].stage = stage  # type: ignore[assignment]

            progress("loading_model")
            result = self.engine(
                source,
                folder / "background.m4a",
                folder / "result.json",
                requested_device,
                progress,
                event,
            )
            with self._lock:
                job = self._jobs[job_id]
                if event.is_set():
                    job.status = "cancelled"
                else:
                    job.status = "succeeded"
                    job.result = SeparationResult.model_validate(result.to_json_dict())
                    self._completed_at[job_id] = time.monotonic()
                    retain = True
                    expiry_timer = threading.Timer(
                        self._result_ttl_seconds, self._expire, args=(job_id,)
                    )
                    expiry_timer.daemon = True
                    self._expiry_timers[job_id] = expiry_timer
            if expiry_timer:
                expiry_timer.start()
        except CancelledError:
            with self._lock:
                self._jobs[job_id].status = "cancelled"
                self._completed_at[job_id] = time.monotonic()
        except Exception as error:
            LOGGER.exception("Local separation job %s failed", job_id)
            with self._lock:
                job = self._jobs[job_id]
                job.status = "failed"
                job.error = _separation_error(error)
                self._completed_at[job_id] = time.monotonic()
        finally:
            source.unlink(missing_ok=True)
            if not retain:
                shutil.rmtree(folder, ignore_errors=True)

    def _cleanup_expired(self) -> None:
        threshold = time.monotonic() - self._result_ttl_seconds
        with self._lock:
            expired = [
                job_id for job_id, completed in self._completed_at.items() if completed < threshold
            ]
            for job_id in expired:
                folder = self._folders.pop(job_id, None)
                self._completed_at.pop(job_id, None)
                self._jobs.pop(job_id, None)
                self._cancel.pop(job_id, None)
                timer = self._expiry_timers.pop(job_id, None)
                if timer:
                    timer.cancel()
                if folder:
                    shutil.rmtree(folder, ignore_errors=True)

    def _expire(self, job_id: str) -> None:
        with self._lock:
            folder = self._folders.pop(job_id, None)
            self._completed_at.pop(job_id, None)
            self._jobs.pop(job_id, None)
            self._cancel.pop(job_id, None)
            self._expiry_timers.pop(job_id, None)
        if folder:
            shutil.rmtree(folder, ignore_errors=True)

    def _cleanup_orphaned_folders(self) -> None:
        threshold = time.time() - self._result_ttl_seconds
        for folder in self._temp_root.glob("take-two-separation-*"):
            try:
                if folder.is_dir() and folder.stat().st_mtime < threshold:
                    shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                LOGGER.warning("Could not inspect stale local separation folder %s", folder)


def _separation_error(error: Exception) -> str:
    text = str(error)
    lowered = text.lower()
    if "checksum" in lowered:
        return "Yerel ayırma modelinin bütünlük kontrolü başarısız. Model kurulumunu kontrol et."
    if "model" in lowered and ("bulunamad" in lowered or "missing" in lowered):
        return "Gerekli yerel ayırma modeli bulunamadı. Model kurulumunu kontrol et."
    if "cuda" in lowered:
        return "CUDA ile ayırma tamamlanamadı. Yerel CUDA kurulumunu kontrol et veya CPU kullan."
    if text.startswith(("Kaynak", "Video", "Kodlanan", "Sıkıştırılmış")):
        return text
    return "Konuşmalar yerel olarak ayrılamadı. Servis terminalindeki ayrıntıları kontrol et."
