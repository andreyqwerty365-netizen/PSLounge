# -*- coding: utf-8 -*-
from __future__ import annotations

from flask import Flask, render_template, jsonify, request, send_file, url_for
from pathlib import Path
from datetime import datetime
from io import BytesIO

from .formatting import _normalize_station_type_key, _parse_date_key
from .licensing import _activate_license_token, _license_status, _require_license
from .paths import _app_dir, _resource_path, log
from .report_data import _collect_report_rows
from .state import _read_state_file
from .business.api import register
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


@app.get("/demo")
def demo():
    return render_template("index.html", demo=True)


@app.get("/about")
def about():
    return render_template("about.html")


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
    denied = _authorize()
    if denied:
        return denied
    return jsonify(_read_database_state())


@app.post("/api/backup")
def api_set_backup():
    return _save_database_state()


@app.get("/api/export/today.xlsx")
def api_export_today_xlsx():
    denied = _authorize()
    if denied:
        return denied
    try:
        key = _parse_date_key(
            request.args.get("date"), datetime.now().strftime("%Y-%m-%d")
        )
    except ValueError:
        return jsonify({"ok": False, "error": "invalid_date"}), 400
    state = _read_database_state()
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
    denied = _authorize()
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

    state = _read_database_state()
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


_authorize, _read_database_state, _save_database_state = register(
    app, lambda: _require_license(), lambda: _app_dir(), lambda: _read_state_file()
)
