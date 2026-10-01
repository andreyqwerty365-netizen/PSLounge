# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import json
import math
import tempfile
import threading
from pathlib import Path
from datetime import datetime, timedelta

from .constants import (
    SCHEMA_VERSION,
    STATE_BAK_FILE,
    STATE_FILE,
    STATE_HISTORY_DIR,
    STATE_HISTORY_RETENTION_DAYS,
)
from .formatting import _normalize_station_type_key, _safe_int
from .paths import _app_dir, log
from .report_data import _is_valid_session_record, _normalize_station_definition

STATE_LOCK = threading.RLock()


def _default_state(source: str = "default") -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "version": 1,
        "lastModified": 0,
        "stations": None,
        "sessions": None,
        "settings": None,
        "achievements": None,
        "source": source,
        "recoveryDiagnostics": {
            "selectedSource": source,
            "primaryValid": False,
            "backupValid": False,
            "fallbackUsed": False,
        },
    }


def _is_valid_station_list(value: object) -> bool:
    if not isinstance(value, list) or not value:
        return False
    allowed_status = {"idle", "running", "grace", "overdue"}
    seen_ids: set[int] = set()
    for idx, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            return False
        sid = _safe_int(item.get("id"), idx)
        if sid <= 0 or sid in seen_ids:
            return False
        seen_ids.add(sid)
        if item.get("status") not in allowed_status:
            return False
        if item.get("startTime") is not None and not isinstance(
            item.get("startTime"), (int, float)
        ):
            return False
        if item.get("endTime") is not None and not isinstance(
            item.get("endTime"), (int, float)
        ):
            return False
        if (
            item.get("stationType") is not None
            and _normalize_station_type_key(item.get("stationType"), "") == ""
        ):
            return False
    return True


def _is_valid_sessions_map(value: object) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    for day_key, entries in value.items():
        if not isinstance(day_key, str) or not isinstance(entries, list):
            return False
        try:
            datetime.strptime(day_key, "%Y-%m-%d")
        except Exception:
            return False
        for item in entries:
            if not _is_valid_session_record(item):
                return False
    return True


def _is_valid_settings_blob(value: object) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    defs = value.get("stationDefinitions")
    if defs is not None:
        if not isinstance(defs, list) or not defs:
            return False
        seen_ids: set[int] = set()
        for idx, item in enumerate(defs):
            normalized = _normalize_station_definition(item, idx)
            if normalized is None or normalized["id"] in seen_ids:
                return False
            seen_ids.add(normalized["id"])
    return True


def _is_valid_achievements_blob(value: object) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        return False

    version = value.get("version", 1)
    backfill_version = value.get("backfillVersion", 0)
    unseen_ids = value.get("unseenIds", [])
    unlocked = value.get("unlocked", {})
    progress = value.get("progress", {})
    break_events = value.get("breakEvents", [])
    clean_tracking_started_at = value.get("cleanTrackingStartedAt")

    if not isinstance(version, int) or version < 1:
        return False
    if not isinstance(backfill_version, int) or backfill_version < 0:
        return False
    if not isinstance(unseen_ids, list) or any(
        not isinstance(item, str) for item in unseen_ids
    ):
        return False
    if not isinstance(unlocked, dict):
        return False
    for key, item in unlocked.items():
        if not isinstance(key, str) or not isinstance(item, dict):
            return False
        unlocked_at = item.get("unlockedAt")
        seen_at = item.get("seenAt")
        if not isinstance(unlocked_at, (int, float)):
            return False
        if seen_at is not None and not isinstance(seen_at, (int, float)):
            return False
    if not isinstance(progress, dict):
        return False
    for key, item in progress.items():
        if not isinstance(key, str) or not isinstance(item, (int, float)):
            return False
    if not isinstance(break_events, list) or any(
        not isinstance(item, (int, float)) for item in break_events
    ):
        return False
    if clean_tracking_started_at is not None and not isinstance(
        clean_tracking_started_at, (int, float)
    ):
        return False
    return True


def _has_finite_numbers(value: object) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_has_finite_numbers(item) for item in value.values())
    if isinstance(value, list):
        return all(_has_finite_numbers(item) for item in value)
    return True


def _is_valid_state_payload(data: object) -> bool:
    if not isinstance(data, dict) or not _has_finite_numbers(data):
        return False
    if isinstance(data.get("lastModified", 0), bool) or not isinstance(
        data.get("lastModified", 0), int
    ):
        return False
    if not _is_valid_station_list(data.get("stations")):
        return False
    if not _is_valid_sessions_map(data.get("sessions")):
        return False
    if not _is_valid_settings_blob(data.get("settings")):
        return False
    if not _is_valid_achievements_blob(data.get("achievements")):
        return False
    return True


def _trim_history_dir(history_dir: Path, retention_days: int) -> None:
    if retention_days <= 0 or not history_dir.exists():
        return
    cutoff = datetime.now().date() - timedelta(days=retention_days)
    for item in history_dir.glob("*.json"):
        try:
            d = datetime.strptime(item.stem, "%Y-%m-%d").date()
        except Exception:
            continue
        if d < cutoff:
            try:
                item.unlink(missing_ok=True)
            except Exception as e:
                log(f"Failed to trim history snapshot {item.name}: {e!r}")


def _read_json_candidate(path: Path) -> dict | None:
    try:
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        if not _is_valid_state_payload(data):
            log(f"State candidate {path.name} failed validation")
            return None
        data.setdefault("schemaVersion", SCHEMA_VERSION)
        data.setdefault("version", 1)
        data.setdefault("lastModified", 0)
        data.setdefault("achievements", None)
        return data
    except Exception as e:
        log(f"Failed to read json candidate {path.name}: {e!r}")
        return None


def _read_state_file() -> dict:
    app_dir = _app_dir()
    primary = app_dir / STATE_FILE
    backup = app_dir / STATE_BAK_FILE

    primary_data = _read_json_candidate(primary)
    backup_data = _read_json_candidate(backup)
    diagnostics = {
        "selectedSource": "default",
        "primaryValid": primary_data is not None,
        "backupValid": backup_data is not None,
        "fallbackUsed": False,
    }
    if primary_data is not None:
        primary_data["source"] = "primary"
        primary_data["recoveryDiagnostics"] = {
            **diagnostics,
            "selectedSource": "primary",
        }
        return primary_data

    if backup_data is not None:
        backup_data["source"] = "backup"
        backup_data["recoveryDiagnostics"] = {
            **diagnostics,
            "selectedSource": "backup",
            "fallbackUsed": True,
        }
        return backup_data

    history_dir = app_dir / STATE_HISTORY_DIR
    if history_dir.exists():
        for snapshot in sorted(history_dir.glob("*.json"), reverse=True):
            snapshot_data = _read_json_candidate(snapshot)
            if snapshot_data is not None:
                snapshot_data["source"] = "snapshot"
                snapshot_data["recoveryDiagnostics"] = {
                    **diagnostics,
                    "selectedSource": "snapshot",
                    "fallbackUsed": True,
                }
                return snapshot_data
    return _default_state()


def _replace_json(path: Path, data: dict) -> None:
    """Replace one file without exposing partial JSON or sharing temporary names."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=path.name + ".",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            json.dump(data, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _atomic_write_json(path: Path, data: dict) -> None:
    with STATE_LOCK:
        # A corrupt primary must never overwrite the last valid backup.
        previous = _read_json_candidate(path)
        if previous is not None:
            _replace_json(path.parent / STATE_BAK_FILE, previous)
        _replace_json(path, data)
        try:
            history_dir = path.parent / STATE_HISTORY_DIR
            history_dir.mkdir(exist_ok=True)
            date_key = datetime.now().strftime("%Y-%m-%d")
            _replace_json(history_dir / f"{date_key}.json", data)
            _trim_history_dir(
                history_dir,
                int(
                    os.environ.get(
                        "PS_LOUNGE_HISTORY_DAYS", str(STATE_HISTORY_RETENTION_DAYS)
                    )
                ),
            )
        except Exception as exc:
            log(f"Failed to write daily state snapshot: {exc!r}")


def _trim_sessions(sessions: dict, retention_days: int) -> dict:
    if retention_days <= 0:
        return sessions
    cutoff = datetime.now().date() - timedelta(days=retention_days)
    out = {}
    for k, v in sessions.items():
        try:
            d = datetime.strptime(k, "%Y-%m-%d").date()
        except Exception:
            # keep unknown keys
            out[k] = v
            continue
        if d >= cutoff:
            out[k] = v
    return out
