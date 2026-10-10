from __future__ import annotations

import importlib.util
import json
import os

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import __version__
from .cinematic import PROVIDER, checkpoint_status, separation_python
from .config import Settings, configure_private_caches
from .jobs import Engine, JobManager
from .media import valid_container_signature
from .models import LocalModelEngine
from .schemas import (
    Health,
    HealthIssue,
    JobEnvelope,
    SeparationHealth,
    SeparationHealthIssue,
    SeparationJobEnvelope,
)
from .separation_jobs import SeparationEngine, SeparationJobManager

MAX_MEDIA_BYTES = 25 * 1024 * 1024
MAX_DURATION_MS = 10 * 60 * 1000
ALLOWED_TYPES = {"video/webm": ".webm", "video/mp4": ".mp4"}


def create_app(
    settings: Settings | None = None,
    engine: Engine | None = None,
    separation_engine: SeparationEngine | None = None,
) -> FastAPI:
    current = settings or Settings()
    configure_private_caches(current, offline=True)
    manager = JobManager(engine or LocalModelEngine(current))
    separation_manager = (
        SeparationJobManager(separation_engine) if separation_engine else SeparationJobManager()
    )
    api = FastAPI(title="Take Two Local AI", version=__version__, docs_url=None, redoc_url=None)
    api.add_middleware(
        CORSMiddleware,
        allow_origins=list(current.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "X-Take-Two-Companion"],
    )

    @api.middleware("http")
    async def enforce_browser_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in current.allowed_origins:
            return JSONResponse({"detail": "Bu web sitesi yerel AI servisine erişemez."}, 403)
        if (
            origin is not None
            and request.method != "OPTIONS"
            and request.headers.get("x-take-two-companion") != "1"
        ):
            return JSONResponse({"detail": "Yerel AI istek başlığı eksik."}, 403)
        return await call_next(request)

    @api.get("/v1/health", response_model=Health, response_model_by_alias=True)
    def health() -> Health:
        issues: list[HealthIssue] = []
        packages_ready = all(
            importlib.util.find_spec(name) is not None
            for name in ("faster_whisper", "pyannote.audio", "torch")
        )
        if not packages_ready:
            issues.append(
                HealthIssue(
                    code="dependencies_missing",
                    message="Yerel model paketleri kurulu değil. npm run ai:setup komutunu çalıştır.",
                )
            )
        models_ready = _models_ready(current)
        if not models_ready:
            issues.append(
                HealthIssue(
                    code="models_missing",
                    message="Model dosyaları indirilmemiş. npm run ai:models komutunu çalıştır.",
                )
            )
            if not os.getenv("HF_TOKEN"):
                issues.append(
                    HealthIssue(
                        code="model_access_missing",
                        message="Community-1 model erişimi henüz yapılandırılmamış.",
                    )
                )
        return Health(
            version=__version__,
            status="ready" if not issues else "setup_required",
            device="cuda" if current.device == "cuda" else "cpu",
            transcription_model=current.whisper_model,
            diarization_model=current.diarization_model,
            issues=issues,
        )

    @api.post("/v1/jobs", status_code=202, response_model=JobEnvelope, response_model_by_alias=True)
    async def create_job(
        media: UploadFile = File(...),
        duration_ms: int = Form(..., alias="durationMs"),
        expected_speaker_count: int | None = Form(None, alias="expectedSpeakerCount"),
    ) -> JobEnvelope:
        content_type = (media.content_type or "").lower()
        if content_type not in ALLOWED_TYPES:
            raise HTTPException(415, "Yalnızca WebM veya MP4 klipler desteklenir.")
        if duration_ms < 1 or duration_ms > MAX_DURATION_MS:
            raise HTTPException(400, "Video süresi geçerli değil.")
        if expected_speaker_count is not None and not 1 <= expected_speaker_count <= 12:
            raise HTTPException(400, "Beklenen konuşmacı sayısı 1 ile 12 arasında olmalı.")
        payload = await media.read(MAX_MEDIA_BYTES + 1)
        if not payload or len(payload) > MAX_MEDIA_BYTES:
            raise HTTPException(413 if payload else 400, "Video boş veya 25 MB sınırını aşıyor.")
        if not valid_container_signature(payload[:16], content_type):
            raise HTTPException(400, "Dosya imzası seçilen video biçimiyle eşleşmiyor.")
        return JobEnvelope(
            job=manager.create(
                payload,
                ALLOWED_TYPES[content_type],
                duration_ms,
                expected_speaker_count,
            )
        )

    @api.get("/v1/jobs/{job_id}", response_model=JobEnvelope, response_model_by_alias=True)
    def get_job(job_id: str) -> JobEnvelope:
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(404, "Analiz işi bulunamadı.")
        return JobEnvelope(job=job)

    @api.delete("/v1/jobs/{job_id}", response_model=JobEnvelope, response_model_by_alias=True)
    def cancel_job(job_id: str) -> JobEnvelope:
        job = manager.cancel(job_id)
        if job is None:
            raise HTTPException(404, "Analiz işi bulunamadı.")
        return JobEnvelope(job=job)

    @api.get(
        "/v1/separation/health",
        response_model=SeparationHealth,
        response_model_by_alias=True,
    )
    def separation_health() -> SeparationHealth:
        requested = os.getenv("TAKETWO_SEPARATION_DEVICE", "auto").lower()
        if requested not in {"auto", "cpu", "cuda"}:
            requested = "auto"
        issues: list[SeparationHealthIssue] = []
        if separation_python(requested) is None:
            issues.append(
                SeparationHealthIssue(
                    code="environment_missing",
                    message="Yerel sinematik ayırma ortamı kurulu değil. npm run ai:separation:setup:cuda komutunu çalıştır.",
                )
            )
        checkpoint, _actual = checkpoint_status(current)
        if checkpoint == "missing":
            issues.append(
                SeparationHealthIssue(
                    code="model_missing",
                    message="Gerekli yerel ayırma modeli bulunamadı. npm run ai:separation:fallback-model komutunu çalıştır.",
                )
            )
        elif checkpoint == "invalid":
            issues.append(
                SeparationHealthIssue(
                    code="model_checksum_invalid",
                    message="Yerel ayırma modelinin bütünlük kontrolü başarısız.",
                )
            )
        return SeparationHealth(
            status="ready" if not issues else "setup_required",
            provider=PROVIDER,
            requested_device=requested,
            issues=issues,
        )

    @api.post(
        "/v1/separation/jobs",
        status_code=202,
        response_model=SeparationJobEnvelope,
        response_model_by_alias=True,
    )
    async def create_separation_job(
        media: UploadFile = File(...),
        duration_ms: int = Form(..., alias="durationMs"),
        requested_device: str = Form("auto", alias="requestedDevice"),
    ) -> SeparationJobEnvelope:
        content_type = (media.content_type or "").lower()
        if content_type not in ALLOWED_TYPES:
            raise HTTPException(415, "Yalnızca WebM veya MP4 klipler desteklenir.")
        if duration_ms < 1 or duration_ms > MAX_DURATION_MS:
            raise HTTPException(400, "Video süresi geçerli değil.")
        requested_device = requested_device.lower()
        if requested_device not in {"auto", "cpu", "cuda"}:
            raise HTTPException(400, "Ayırma cihazı seçimi geçerli değil.")
        payload = await media.read(MAX_MEDIA_BYTES + 1)
        if not payload or len(payload) > MAX_MEDIA_BYTES:
            raise HTTPException(413 if payload else 400, "Video boş veya 25 MB sınırını aşıyor.")
        if not valid_container_signature(payload[:16], content_type):
            raise HTTPException(400, "Dosya imzası seçilen video biçimiyle eşleşmiyor.")
        return SeparationJobEnvelope(
            job=separation_manager.create(payload, ALLOWED_TYPES[content_type], requested_device)
        )

    @api.get("/v1/separation/jobs/{job_id}/background")
    def get_separation_background(job_id: str) -> FileResponse:
        path = separation_manager.result_path(job_id)
        if path is None:
            raise HTTPException(404, "Hazır arka plan sesi bulunamadı.")
        return FileResponse(
            path,
            media_type="audio/mp4",
            filename="konusmasiz-arka-plan.m4a",
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )

    @api.get(
        "/v1/separation/jobs/{job_id}",
        response_model=SeparationJobEnvelope,
        response_model_by_alias=True,
    )
    def get_separation_job(job_id: str) -> SeparationJobEnvelope:
        job = separation_manager.get(job_id)
        if job is None:
            raise HTTPException(404, "Ayırma işi bulunamadı.")
        return SeparationJobEnvelope(job=job)

    @api.delete(
        "/v1/separation/jobs/{job_id}",
        response_model=SeparationJobEnvelope,
        response_model_by_alias=True,
    )
    def cancel_separation_job(job_id: str) -> SeparationJobEnvelope:
        job = separation_manager.cancel(job_id)
        if job is None:
            raise HTTPException(404, "Ayırma işi bulunamadı.")
        return SeparationJobEnvelope(job=job)

    return api


def _models_ready(settings: Settings) -> bool:
    try:
        marker = json.loads(settings.ready_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (
        marker.get("transcriptionModel") == settings.whisper_model
        and marker.get("diarizationModel") == settings.diarization_model
    )


app = create_app()


def main() -> None:
    import uvicorn

    settings = Settings()
    uvicorn.run("take_two_ai.app:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    main()
