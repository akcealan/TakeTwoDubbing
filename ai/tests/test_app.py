from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from take_two_ai.app import create_app
from take_two_ai.cinematic import ProductSeparationResult
from take_two_ai.config import Settings
from take_two_ai.domain import Transcript, TranscriptSegment, merge_to_draft


class FixtureEngine:
    def __init__(self):
        self.expected_speaker_count = None

    def run(self, source, duration_ms, progress, cancel, expected_speaker_count=None):
        self.expected_speaker_count = expected_speaker_count
        assert source.read_bytes().startswith(bytes((0x1A, 0x45, 0xDF, 0xA3)))
        for stage in ("preparing_audio", "transcribing", "diarizing", "merging", "building_draft"):
            progress(stage)
        return merge_to_draft(
            Transcript((TranscriptSegment(100, 800, "Deneme"),), "tr", 0.8),
            [],
            duration_ms,
            transcription_model="fixture",
            diarization_model="fixture",
            device="cpu",
        )


def settings(tmp_path: Path) -> Settings:
    return Settings(cache_dir=tmp_path, allowed_origins=("http://127.0.0.1:5173",))


def test_health_reports_setup_requirements_without_loading_models(tmp_path):
    response = TestClient(create_app(settings(tmp_path), FixtureEngine())).get("/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "take-two-local-ai"
    assert body["status"] == "setup_required"
    assert {issue["code"] for issue in body["issues"]} >= {"models_missing"}


def test_health_ready_uses_explicit_model_marker(tmp_path, monkeypatch):
    current = settings(tmp_path)
    current.ready_file.write_text(
        json.dumps(
            {
                "transcriptionModel": current.whisper_model,
                "diarizationModel": current.diarization_model,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("take_two_ai.app.importlib.util.find_spec", lambda name: object())
    body = TestClient(create_app(current, FixtureEngine())).get("/v1/health").json()
    assert body["status"] == "ready"
    assert body["issues"] == []


def test_invalid_media_is_rejected_before_job_creation(tmp_path):
    client = TestClient(create_app(settings(tmp_path), FixtureEngine()))
    response = client.post(
        "/v1/jobs",
        files={"media": ("fake.webm", b"not-webm", "video/webm")},
        data={"durationMs": "1000"},
    )
    assert response.status_code == 400
    unsupported = client.post(
        "/v1/jobs",
        files={"media": ("fake.mov", b"anything", "video/quicktime")},
        data={"durationMs": "1000"},
    )
    assert unsupported.status_code == 415


def test_browser_origin_and_companion_header_are_enforced(tmp_path):
    client = TestClient(create_app(settings(tmp_path), FixtureEngine()))
    denied = client.get(
        "/v1/health",
        headers={"Origin": "https://attacker.example", "X-Take-Two-Companion": "1"},
    )
    assert denied.status_code == 403
    missing_header = client.get("/v1/health", headers={"Origin": "http://127.0.0.1:5173"})
    assert missing_header.status_code == 403
    allowed = client.get(
        "/v1/health",
        headers={"Origin": "http://127.0.0.1:5173", "X-Take-Two-Companion": "1"},
    )
    assert allowed.status_code == 200
    preflight = client.options(
        "/v1/jobs",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-take-two-companion,content-type",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    assert "x-take-two-companion" in preflight.headers["access-control-allow-headers"].lower()


def test_future_production_origin_is_configurable_and_cli_path_stays_available(tmp_path):
    current = Settings(
        cache_dir=tmp_path,
        allowed_origins=("https://take-two.example.workers.dev",),
    )
    client = TestClient(create_app(current, FixtureEngine()))
    browser = client.get(
        "/v1/health",
        headers={
            "Origin": "https://take-two.example.workers.dev",
            "X-Take-Two-Companion": "1",
        },
    )
    assert browser.status_code == 200
    assert browser.headers["access-control-allow-origin"] == "https://take-two.example.workers.dev"
    assert client.get("/v1/health").status_code == 200
    assert "hf_" not in browser.text.lower()
    assert str(tmp_path) not in browser.text


def test_non_loopback_bind_is_rejected(tmp_path):
    try:
        Settings(host="0.0.0.0", cache_dir=tmp_path)
    except ValueError as error:
        assert "loopback" in str(error)
    else:
        raise AssertionError("non-loopback AI bind was accepted")


def test_job_lifecycle_returns_ai_draft_and_supports_delete(tmp_path):
    engine = FixtureEngine()
    client = TestClient(create_app(settings(tmp_path), engine))
    response = client.post(
        "/v1/jobs",
        files={
            "media": (
                "sample.webm",
                bytes((0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0)),
                "video/webm",
            )
        },
        data={"durationMs": "1000", "expectedSpeakerCount": "3"},
    )
    assert response.status_code == 202
    job_id = response.json()["job"]["id"]
    for _ in range(50):
        body = client.get(f"/v1/jobs/{job_id}").json()["job"]
        if body["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.01)
    assert body["status"] == "succeeded"
    assert engine.expected_speaker_count == 3
    assert body["result"]["lines"][0]["text"] == "Deneme"
    cancelled = client.delete(f"/v1/jobs/{job_id}")
    assert cancelled.status_code == 200


def test_expected_speaker_count_is_optional_and_bounded(tmp_path):
    engine = FixtureEngine()
    client = TestClient(create_app(settings(tmp_path), engine))
    invalid = client.post(
        "/v1/jobs",
        files={
            "media": (
                "sample.webm",
                bytes((0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0)),
                "video/webm",
            )
        },
        data={"durationMs": "1000", "expectedSpeakerCount": "13"},
    )
    assert invalid.status_code == 400


def test_separation_health_reports_model_setup_without_blocking_service(tmp_path):
    body = (
        TestClient(create_app(settings(tmp_path), FixtureEngine()))
        .get("/v1/separation/health")
        .json()
    )
    assert body["status"] == "setup_required"
    assert "model_missing" in {issue["code"] for issue in body["issues"]}


def test_separation_job_returns_previewable_m4a_and_supports_cleanup(tmp_path):
    def separate(source, output, metadata, requested_device, progress, cancel):
        assert source.name == "source.webm"
        assert requested_device == "auto"
        for stage in ("loading_model", "separating", "encoding"):
            progress(stage)
        output.write_bytes(b"\x00\x00\x00\x0cftypM4A ")
        return ProductSeparationResult(
            mime_type="audio/mp4",
            byte_size=output.stat().st_size,
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

    client = TestClient(create_app(settings(tmp_path), FixtureEngine(), separate))
    response = client.post(
        "/v1/separation/jobs",
        files={
            "media": (
                "sample.webm",
                bytes((0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0)),
                "video/webm",
            )
        },
        data={"durationMs": "1000", "requestedDevice": "auto"},
    )
    assert response.status_code == 202
    job_id = response.json()["job"]["id"]
    for _ in range(50):
        job = client.get(f"/v1/separation/jobs/{job_id}").json()["job"]
        if job["status"] not in {"queued", "running"}:
            break
        time.sleep(0.01)
    assert job["status"] == "succeeded"
    assert job["result"]["mimeType"] == "audio/mp4"
    background = client.get(f"/v1/separation/jobs/{job_id}/background")
    assert background.status_code == 200
    assert background.content[4:8] == b"ftyp"
    assert client.delete(f"/v1/separation/jobs/{job_id}").status_code == 200
    assert client.get(f"/v1/separation/jobs/{job_id}/background").status_code == 404
