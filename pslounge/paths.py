# -*- coding: utf-8 -*-
from __future__ import annotations

import sys
from pathlib import Path
from datetime import datetime

from .constants import LOG_FILE


def _app_dir() -> Path:
    # In PyInstaller EXE: executable dir. In source: script dir.
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def _resource_path(*parts: str) -> str:
    """Absolute path to bundled resources (works in source run and PyInstaller EXE)."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        base = Path(getattr(sys, "_MEIPASS"))  # type: ignore[attr-defined]
    else:
        base = Path(__file__).resolve().parents[1]
    return str(base.joinpath(*parts))


def log(msg: str) -> None:
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        (_app_dir() / LOG_FILE).open("a", encoding="utf-8").write(f"[{ts}] {msg}\n")
    except Exception:
        pass
