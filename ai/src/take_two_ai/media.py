from __future__ import annotations

import wave
from pathlib import Path

import av


class InvalidMediaError(ValueError):
    pass


def valid_container_signature(data: bytes, mime_type: str) -> bool:
    if mime_type == "video/webm":
        return data.startswith(bytes((0x1A, 0x45, 0xDF, 0xA3)))
    if mime_type == "video/mp4":
        return len(data) >= 12 and data[4:8] == b"ftyp"
    return False


def extract_mono_wav(source: Path, target: Path) -> None:
    """Decode with PyAV's bundled FFmpeg libraries; no system FFmpeg process is used."""
    try:
        with av.open(str(source)) as container, wave.open(str(target), "wb") as output:
            stream = next(
                (candidate for candidate in container.streams if candidate.type == "audio"), None
            )
            if stream is None:
                raise InvalidMediaError("Kaynak klipte çözümlenebilir bir ses kanalı yok.")
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16_000)
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16_000)
            wrote_bytes = 0
            for frame in container.decode(stream):
                for converted in resampler.resample(frame):
                    payload = converted.to_ndarray().tobytes()
                    output.writeframesraw(payload)
                    wrote_bytes += len(payload)
            for converted in resampler.resample(None):
                payload = converted.to_ndarray().tobytes()
                output.writeframesraw(payload)
                wrote_bytes += len(payload)
            if wrote_bytes == 0:
                raise InvalidMediaError("Kaynak klipte çözümlenebilir ses bulunamadı.")
    except InvalidMediaError:
        raise
    except (av.error.FFmpegError, EOFError, OSError, StopIteration) as error:
        raise InvalidMediaError("Video veya ses dosyası çözümlenemedi.") from error
