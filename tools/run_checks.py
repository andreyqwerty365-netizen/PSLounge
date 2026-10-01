"""Portable public checks; signed-license smoke tests remain separate."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lint", action="store_true")
    parser.add_argument("--backend", action="store_true")
    parser.add_argument("--ui", action="store_true")
    args = parser.parse_args()
    venv_python = (
        ROOT
        / ".venv"
        / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    )
    python = str(venv_python) if venv_python.exists() else sys.executable
    commands = [
        [
            python,
            "-m",
            "ruff",
            "check",
            "main.py",
            "pslounge",
            "tests",
            "tools/backend_smoke_check.py",
            "tools/run_checks.py",
            "tools/business_test_server.py",
        ]
    ]
    if not args.lint:
        commands += [
            [python, "tools/backend_smoke_check.py"],
            [python, "-m", "pytest", "-q"],
        ]
        if not args.backend:
            commands += [
                ["node", "tools/achievement_break_actions_check.cjs"],
                ["node", "tools/station_order_check.cjs"],
                ["node", "tools/station_asset_check.cjs"],
                ["node", "--test", "tests/frontend.test.mjs"],
            ]
        if args.ui:
            commands.append(["node", "tools/frontend_smoke_check.cjs"])
            commands.append(["node", "tools/business_smoke_check.cjs"])
    for command in commands:
        print("Running:", " ".join(command), flush=True)
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
