from __future__ import annotations

import hashlib
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import Settings, configure_private_caches
from .separation import (
    BANDIT_CHECKPOINT_BYTES,
    BANDIT_CHECKPOINT_FILENAME,
    BANDIT_CHECKPOINT_SHA256,
    BANDIT_MODEL,
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_verified(
    url: str,
    target: Path,
    *,
    expected_bytes: int,
    expected_sha256: str,
    attempts: int = 6,
) -> Path:
    """Resume an official download when supported; publish only verified bytes."""
    if target.is_file():
        if target.stat().st_size == expected_bytes and _sha256(target) == expected_sha256:
            return target
        raise RuntimeError(f"Var olan ağırlık checksum/size doğrulamasını geçemedi: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        existing = partial.stat().st_size if partial.exists() else 0
        headers = {"User-Agent": "Take-Two-local-model-downloader/1"}
        if existing:
            headers["Range"] = f"bytes={existing}-"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                status = getattr(response, "status", 200)
                append = existing > 0 and status == 206
                mode = "ab" if append else "wb"
                if existing and not append:
                    existing = 0
                with partial.open(mode) as output:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        output.write(block)
            actual_bytes = partial.stat().st_size
            if actual_bytes != expected_bytes:
                raise RuntimeError(
                    f"Eksik model indirmesi: {actual_bytes}/{expected_bytes} bayt; yeniden denenecek."
                )
            actual_sha256 = _sha256(partial)
            if actual_sha256 != expected_sha256:
                partial.unlink(missing_ok=True)
                raise RuntimeError(
                    f"Model SHA-256 uyuşmadı: beklenen {expected_sha256}, bulunan {actual_sha256}"
                )
            partial.replace(target)
            return target
        except (OSError, RuntimeError, urllib.error.URLError) as error:
            last_error = error
            if attempt == attempts:
                break
            delay = min(30, 2**attempt)
            print(
                f"İndirme denemesi {attempt}/{attempts} tamamlanamadı: {error}. "
                f"{delay} sn sonra {partial.stat().st_size if partial.exists() else 0} bayttan devam edilecek.",
                flush=True,
            )
            time.sleep(delay)
    raise RuntimeError(f"Resmi Bandit ağırlığı indirilemedi: {last_error}")


def main() -> None:
    settings = Settings()
    configure_private_caches(settings, offline=False)
    try:
        from bandit_infer.checkpoints import get_spec
    except ImportError as error:
        raise SystemExit(
            "Bandit inference paketi eksik. Önce npm run ai:separation:setup çalıştır."
        ) from error
    spec = get_spec(BANDIT_MODEL)
    print(f"Model: {spec.key}")
    print(f"Resmi kaynak: {spec.url}")
    print(f"Ağırlık lisansı: {spec.license}")
    print(f"Beklenen SHA-256: {BANDIT_CHECKPOINT_SHA256}")
    path = download_verified(
        spec.url,
        settings.separation_model_cache / BANDIT_CHECKPOINT_FILENAME,
        expected_bytes=BANDIT_CHECKPOINT_BYTES,
        expected_sha256=BANDIT_CHECKPOINT_SHA256,
    )
    print(f"Doğrulanmış yerel ağırlık: {path}")


if __name__ == "__main__":
    main()
