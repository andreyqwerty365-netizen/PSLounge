# -*- coding: utf-8 -*-
from __future__ import annotations

from flask import Flask, render_template, jsonify, request, send_file, url_for
import os
from pathlib import Path
from datetime import datetime
from io import BytesIO

from .constants import SCHEMA_VERSION, STATE_FILE
from .formatting import _normalize_station_type_key, _parse_date_key
from .licensing import _activate_license_token, _license_status, _require_license
from .paths import _app_dir, _resource_path, log
from .report_data import _collect_report_rows
from .state import (
    STATE_LOCK,
    _atomic_write_json,
    _is_valid_state_payload,
    _read_state_file,
    _trim_sessions,
)
from .workbooks import _build_report_workbook, _build_shift_workbook

app = Flask(
    __name__,
    static_folder=_resource_path("static"),
    template_folder=_resource_path("templates"),
    static_url_path="/static",
)


def _asset_version(relative_path: str) -> str:
    try:
        return str(
            max(
                path.stat().st_mtime_ns
                for path in Path(_resource_path("static")).rglob("*")
                if path.is_file()
            )
        )
    except Exception:
        return "1"


@app.context_processor
def inject_asset_helpers():
    def asset_url(filename: str) -> str:
        return url_for(
            "static", filename=filename, v=_asset_version(f"static/{filename}")
        )

    return {"asset_url": asset_url}


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    # Used by the launcher to verify that the running instance is PS Lounge.
    return "OK:PSLOUNGE", 200


@app.get("/api/license/status")
def api_license_status():
    return jsonify(_license_status())


@app.post("/api/license/activate")
def api_license_activate():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "bad json"}), 400
    token = str(payload.get("token") or payload.get("key") or "").strip()
    if not token:
        return jsonify({"ok": False, "error": "missing_token"}), 400
    try:
        status = _activate_license_token(token)
        return jsonify(status)
    except ValueError as e:
        return jsonify({"ok": False, "error": "invalid_license", "detail": str(e)}), 400
    except Exception as e:
        log(f"Failed to activate license: {e!r}")
        return jsonify({"ok": False, "error": "license_write_failed"}), 500


@app.get("/api/backup")
def api_get_backup():
    denied = _require_license()
    if denied:
        return denied
    return jsonify(_read_state_file())


@app.post("/api/backup")
def api_set_backup():
    denied = _require_license()
    if denied:
        return denied
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "bad json"}), 400

    last_modified = payload.get("lastModified")
    stations = payload.get("stations")
    sessions = payload.get("sessions")
    settings = payload.get("settings")
    achievements = payload.get("achievements")

    if isinstance(last_modified, bool) or not isinstance(last_modified, int):
        return jsonify({"ok": False, "error": "lastModified must be int"}), 400

    with STATE_LOCK:
        # Read current to prevent older overwrite
        current = _read_state_file()
        cur_lm = int(current.get("lastModified") or 0)
        if last_modified < cur_lm:
            return jsonify(
                {
                    "ok": True,
                    "skipped": True,
                    "reason": "older_than_current",
                    "currentLastModified": cur_lm,
                }
            )

        # Trim sessions growth
        retention_days = int(os.environ.get("PS_LOUNGE_RETENTION_DAYS", "60"))
        if isinstance(sessions, dict):
            sessions = _trim_sessions(sessions, retention_days)

        data = {
            "schemaVersion": SCHEMA_VERSION,
            "version": 1,
            "lastModified": last_modified,
            "stations": stations,
            "sessions": sessions,
            "settings": settings,
            "achievements": achievements,
        }

        if not _is_valid_state_payload(data):
            return jsonify({"ok": False, "error": "invalid_state_shape"}), 400

        try:
            _atomic_write_json(_app_dir() / STATE_FILE, data)
            return jsonify({"ok": True})
        except Exception as e:
            log(f"Failed to write state file: {e!r}")
            return jsonify({"ok": False, "error": "write_failed"}), 500


@app.get("/api/export/today.xlsx")
def api_export_today_xlsx():
    denied = _require_license()
    if denied:
        return denied
    try:
        key = _parse_date_key(
            request.args.get("date"), datetime.now().strftime("%Y-%m-%d")
        )
    except ValueError:
        return jsonify({"ok": False, "error": "invalid_date"}), 400
    state = _read_state_file()
    session_rows, sales_rows, period_keys = _collect_report_rows(state, key, key)
    wb = _build_shift_workbook(key, session_rows, sales_rows, state)
    bio = BytesIO()
    wb.save(bio)
    bio.seek(0)
    filename = f"PS_Lounge_Shift_{datetime.strptime(key, '%Y-%m-%d').strftime('%d-%m-%Y')}.xlsx"
    return send_file(
        bio,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=filename,
    )


@app.get("/api/export/report.xlsx")
def api_export_report_xlsx():
    denied = _require_license()
    if denied:
        return denied
    try:
        from_key = _parse_date_key(
            request.args.get("from"), datetime.now().strftime("%Y-%m-%d")
        )
        to_key = _parse_date_key(request.args.get("to"), from_key)
    except ValueError:
        return jsonify({"ok": False, "error": "invalid_date"}), 400
    station_type = _normalize_station_type_key(request.args.get("stationType"), "")
    payment = request.args.get("payment") or ""

    if from_key > to_key:
        from_key, to_key = to_key, from_key

    state = _read_state_file()
    session_rows, sales_rows, period_keys = _collect_report_rows(
        state, from_key, to_key, station_type, payment
    )
    wb = _build_report_workbook(
        from_key, to_key, session_rows, sales_rows, period_keys, state
    )
    bio = BytesIO()
    wb.save(bio)
    bio.seek(0)

    if from_key == to_key:
        filename = f"PS_Lounge_Report_{datetime.strptime(from_key, '%Y-%m-%d').strftime('%d-%m-%Y')}.xlsx"
    else:
        filename = f"PS_Lounge_Report_{datetime.strptime(from_key, '%Y-%m-%d').strftime('%d-%m-%Y')}_{datetime.strptime(to_key, '%Y-%m-%d').strftime('%d-%m-%Y')}.xlsx"
    return send_file(
        bio,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=filename,
    )
