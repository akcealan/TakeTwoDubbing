from __future__ import annotations

import argparse
import json
from pathlib import Path

from take_two_ai.separation import separate_cinematic_audio


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Bandit v2 Multi on private local media")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--private-root", type=Path, default=Path("local-test-media"))
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--outer-chunk-seconds", type=float, default=24.0)
    parser.add_argument("--outer-overlap-seconds", type=float, default=2.0)
    args = parser.parse_args()

    def progress(stage: str, completed: int, total: int) -> None:
        print(f"[{stage}] {completed}/{total}", flush=True)

    result = separate_cinematic_audio(
        args.source,
        args.output,
        private_root=args.private_root,
        requested_device=args.device,
        outer_chunk_seconds=args.outer_chunk_seconds,
        outer_overlap_seconds=args.outer_overlap_seconds,
        progress=progress,
    )
    report_path = result.output_dir / "diagnostics.json"
    report_path.write_text(
        json.dumps(result.diagnostics.to_json_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(result.diagnostics.to_json_dict(), ensure_ascii=False, indent=2))
    print(f"Dinleme adayı: {result.background}")


if __name__ == "__main__":
    main()
