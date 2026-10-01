# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import shutil
import sys
import threading
from datetime import datetime
from pathlib import Path

from .constants import (
    LICENSE_FILE,
    LOG_FILE,
    STATE_BAK_FILE,
    STATE_FILE,
    STATE_HISTORY_DIR,
)

_MIGRATION_LOCK = threading.RLock()
_MIGRATED_LOCATIONS: set[tuple[Path, Path]] = set()


def _copy_missing_file(source: Path, target: Path) -> bool:
    """Copy a known legacy data file without overwriting either copy."""
    if source.is_symlink() or not source.is_file() or target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        output = target.open("xb")
    except FileExistsError:
        return False
    try:
        with source.open("rb") as incoming, output:
            shutil.copyfileobj(incoming, output)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return True


def _migrate_legacy_data(source: Path, target: Path) -> None:
    """Leave portable originals intact; copy only the public licence and state."""
    if source.resolve() == target.resolve():
        return
    with _MIGRATION_LOCK:
        locations = (source.resolve(), target.resolve())
        if locations in _MIGRATED_LOCATIONS:
            return
        for name in (STATE_FILE, STATE_BAK_FILE, LICENSE_FILE):
            _copy_missing_file(source / name, target / name)
        history = source / STATE_HISTORY_DIR
        if history.is_dir() and not history.is_symlink():
            for snapshot in sorted(history.glob("*.json")):
                _copy_missing_file(snapshot, target / STATE_HISTORY_DIR / snapshot.name)
        _MIGRATED_LOCATIONS.add(locations)


def _app_dir() -> Path:
    """Writable data directory, separate from installed application resources."""
    override = os.environ.get("PS_LOUNGE_DATA_DIR", "").strip()
    executable_dir = Path(sys.executable).resolve().parent
    frozen = bool(getattr(sys, "frozen", False))
    if override:
        directory = Path(override).expanduser().resolve()
    elif frozen and sys.platform == "win32":
        local_data = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(local_data) if local_data else Path.home() / "AppData" / "Local"
        directory = (base / "PS Lounge").resolve()
    elif frozen:
        directory = executable_dir
    else:
        directory = Path(__file__).resolve().parents[1]
    directory.mkdir(parents=True, exist_ok=True)
    if frozen and sys.platform == "win32":
        _migrate_legacy_data(executable_dir, directory)
    return directory


def _resource_path(*parts: str) -> str:
    """Absolute bundled resource path; never redirected to the data folder."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        base = Path(getattr(sys, "_MEIPASS"))
    else:
        base = Path(__file__).resolve().parents[1]
    return str(base.joinpath(*parts))


def log(msg: str) -> None:
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with (_app_dir() / LOG_FILE).open("a", encoding="utf-8") as output:
            output.write(f"[{ts}] {msg}\n")
    except Exception:
        pass
