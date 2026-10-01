"""Isolated browser-test server. Never start this script with real product data."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    configured = os.environ.get("PS_LOUNGE_DATA_DIR")
    if not configured:
        parser.error("PS_LOUNGE_DATA_DIR must point to an isolated temporary directory")
    directory = Path(configured).resolve()
    if directory == ROOT or ROOT in directory.parents:
        parser.error("The test data directory must be outside the project checkout")
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        parser.error(
            "The test data directory must be empty; existing data is never reused"
        )
    sys.path.insert(0, str(ROOT))

    from pslounge import state, web

    # These replacements exist only in this explicitly executed testing tool.
    # No production route, environment toggle or licensing module is modified.
    web._app_dir = lambda: directory
    state._app_dir = lambda: directory
    web._require_license = lambda: None
    web._license_status = lambda: {
        "ok": True,
        "licensed": True,
        "status": "active",
        "machineFingerprintLabel": "ISOLATED BUSINESS UI TEST",
        "customer": "Automated test",
    }
    web.app.run(host="127.0.0.1", port=args.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
