from __future__ import annotations

import json
import os

from .config import Settings, configure_private_caches


def main() -> None:
    settings = Settings()
    configure_private_caches(settings, offline=False)
    token = os.getenv("HF_TOKEN")
    if not token:
        raise SystemExit(
            "HF_TOKEN eksik. Community-1 koşullarını kabul et, ücretsiz read token oluştur ve bu terminalde ayarla."
        )

    print(f"Transkripsiyon modeli indiriliyor: {settings.whisper_model}")
    from faster_whisper import WhisperModel

    WhisperModel(
        settings.whisper_model,
        device="cpu",
        compute_type="int8",
        download_root=str(settings.model_cache / "faster-whisper"),
    )

    print(f"Diarization modeli indiriliyor: {settings.diarization_model}")
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(
        settings.diarization_model,
        token=token,
        cache_dir=str(settings.model_cache / "pyannote"),
    )
    if pipeline is None:
        raise SystemExit(
            "Diarization modeli indirilemedi; model koşullarını ve HF_TOKEN değerini kontrol et."
        )
    settings.ready_file.write_text(
        json.dumps(
            {
                "transcriptionModel": settings.whisper_model,
                "diarizationModel": settings.diarization_model,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print("Yerel modeller hazır. Medya analizi sırasında dış AI servisi kullanılmayacak.")


if __name__ == "__main__":
    main()
