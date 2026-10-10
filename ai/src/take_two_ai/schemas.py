from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Character(ApiModel):
    id: str
    name: str


class DialogueLine(ApiModel):
    id: str
    character_id: str
    text: str
    start_ms: int
    end_ms: int


WarningCode = Literal[
    "low_transcription_confidence",
    "uncertain_speaker",
    "overlapping_speech",
    "very_short_line",
    "timing_review",
    "speaker_stabilization_failed",
    "speech_not_detected",
]


class Warning(ApiModel):
    code: WarningCode
    message: str
    severity: Literal["info", "warning"] = "warning"
    line_id: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None


class LineAnalysis(ApiModel):
    line_id: str
    detected_speaker_id: str
    transcript_log_probability: float | None = None
    diarization_confidence: float | None = None
    warning_codes: list[WarningCode] = Field(default_factory=list)


class Analysis(ApiModel):
    source: Literal["local-ai"] = "local-ai"
    transcription_model: str
    diarization_model: str
    device: Literal["cpu", "cuda"]
    detected_language: str | None
    language_probability: float | None
    line_analysis: list[LineAnalysis]
    warnings: list[Warning]


class EditableDraft(ApiModel):
    characters: list[Character]
    lines: list[DialogueLine]
    analysis: Analysis


class HealthIssue(ApiModel):
    code: Literal["dependencies_missing", "models_missing", "model_access_missing"]
    message: str


class Health(ApiModel):
    service: Literal["take-two-local-ai"] = "take-two-local-ai"
    version: str
    status: Literal["ready", "setup_required"]
    device: Literal["cpu", "cuda"]
    transcription_model: str
    diarization_model: str
    issues: list[HealthIssue]


JobStage = Literal[
    "queued", "preparing_audio", "transcribing", "diarizing", "merging", "building_draft"
]
JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class Job(ApiModel):
    id: str
    status: JobStatus
    stage: JobStage
    result: EditableDraft | None = None
    error: str | None = None


class JobEnvelope(ApiModel):
    job: Job


SeparationStage = Literal["queued", "loading_model", "separating", "encoding"]


class SeparationHealthIssue(ApiModel):
    code: Literal["environment_missing", "model_missing", "model_checksum_invalid"]
    message: str


class SeparationHealth(ApiModel):
    service: Literal["take-two-local-ai"] = "take-two-local-ai"
    status: Literal["ready", "setup_required"]
    provider: str
    requested_device: Literal["auto", "cpu", "cuda"]
    issues: list[SeparationHealthIssue]


class SeparationResult(ApiModel):
    mime_type: Literal["audio/mp4"] = "audio/mp4"
    byte_size: int
    duration_ms: int
    sample_rate: int
    channels: Literal[2] = 2
    provider: str
    provider_version: str
    model: str
    device: Literal["cpu", "cuda"]
    inference_seconds: float
    warnings: list[str] = Field(default_factory=list)


class SeparationJob(ApiModel):
    id: str
    status: JobStatus
    stage: SeparationStage
    result: SeparationResult | None = None
    error: str | None = None


class SeparationJobEnvelope(ApiModel):
    job: SeparationJob
