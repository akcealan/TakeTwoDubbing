from __future__ import annotations

import json
import sys
from pathlib import Path

from .cinematic import run_cdx23_product
from .config import Settings, configure_private_caches


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("cinematic worker requires source, output, metadata and device")
    source, output, metadata = map(Path, sys.argv[1:4])
    requested_device = sys.argv[4]
    settings = Settings()
    configure_private_caches(settings, offline=True)
    result = run_cdx23_product(
        source,
        output,
        requested_device,
        settings,
        lambda stage: print(f"STAGE:{stage}", flush=True),
    )
    metadata.write_text(json.dumps(result.to_json_dict(), ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
