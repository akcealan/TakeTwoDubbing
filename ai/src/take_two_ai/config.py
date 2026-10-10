from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

AI_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CACHE = AI_ROOT / ".cache"


@dataclass(frozen=True)
class Settings:
    host: str = os.getenv("TAKETWO_AI_HOST", "127.0.0.1")
    port: int = int(os.getenv("TAKETWO_AI_PORT", "8765"))
    device: str = os.getenv("TAKETWO_AI_DEVICE", "cpu").lower()
    whisper_model: str = os.getenv("TAKETWO_WHISPER_MODEL", "small")
    diarization_model: str = os.getenv(
        "TAKETWO_DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1"
    )
    cache_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv("TAKETWO_AI_CACHE_DIR", str(DEFAULT_CACHE))
        ).resolve()
    )
    allowed_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            value.strip()
            for value in os.getenv(
                "TAKETWO_AI_ALLOWED_ORIGINS",
                "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173",
            ).split(",")
            if value.strip()
        )
    )

    def __post_init__(self) -> None:
        try:
            loopback = ipaddress.ip_address(self.host).is_loopback
        except ValueError:
            loopback = self.host.lower() == "localhost"
        if not loopback:
            raise ValueError(
                "TAKETWO_AI_HOST must be a loopback address; network binding is forbidden."
            )

    @property
    def ready_file(self) -> Path:
        return self.cache_dir / "model-ready.json"

    @property
    def model_cache(self) -> Path:
        return self.cache_dir / "models"

    @property
    def separation_model_cache(self) -> Path:
        return self.model_cache / "bandit-v2"


def configure_private_caches(settings: Settings, *, offline: bool) -> None:
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    settings.model_cache.mkdir(parents=True, exist_ok=True)
    settings.separation_model_cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(settings.model_cache / "huggingface"))
    os.environ.setdefault("HF_HUB_CACHE", str(settings.model_cache / "huggingface" / "hub"))
    os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    if offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
    else:
        os.environ.pop("HF_HUB_OFFLINE", None)
