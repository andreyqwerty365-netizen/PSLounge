from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main as psl_main  # noqa: E402


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    checks: list[str] = []
    client = psl_main.app.test_client()

    response = client.get("/health")
    ensure(response.status_code == 200, f"/health returned {response.status_code}")
    ensure(response.get_data(as_text=True) == "OK:PSLOUNGE", "/health body mismatch")
    checks.append("health")

    response = client.get("/")
    html = response.get_data(as_text=True)
    ensure(response.status_code == 200, f"/ returned {response.status_code}")
    ensure("PS Lounge" in html, "main page title marker missing")
    ensure("/static/styles.css?v=" in html, "styles.css cache-busting parameter missing")
    ensure("/static/app.js?v=" in html, "app.js cache-busting parameter missing")
    checks.append("index")

    response = client.get("/api/license/status")
    ensure(response.status_code == 200, f"/api/license/status returned {response.status_code}")
    payload = response.get_json(silent=True) or {}
    ensure("licensed" in payload, "license status payload missing 'licensed'")
    ensure("machineFingerprintLabel" in payload, "license status payload missing machineFingerprintLabel")
    ensure("fingerprintSourceHealth" in payload, "license status payload missing fingerprintSourceHealth")
    checks.append("license")

    state_payload = psl_main._read_state_file()
    ensure("recoveryDiagnostics" in state_payload, "state payload missing recoveryDiagnostics")
    ensure(isinstance(state_payload.get("recoveryDiagnostics"), dict), "recoveryDiagnostics should be an object")
    checks.append("recovery-diagnostics")

    ordered_defs = psl_main._state_station_definitions({
        "settings": {
            "stationDefinitions": [
                {"id": 3, "name": "PS3", "type": "ps"},
                {"id": 1, "name": "PS1", "type": "ps"},
                {"id": 6, "name": "Nintendo Switch", "type": "switch"},
            ]
        }
    })
    ensure([item["id"] for item in ordered_defs] == [3, 1, 6], "station definition order should follow saved settings order")
    checks.append("station-order")

    session_rows, sales_rows, _ = psl_main._collect_report_rows({
        "settings": {
            "graceMinutes": 10,
            "overdueMinutes": 30,
            "stationDefinitions": [
                {"id": 1, "name": "Симулятор A", "type": "simulator"},
            ],
        },
        "sessions": {
            "2026-04-29": [{
                "stationId": 1,
                "stationName": "Старый симулятор",
                "stationType": "ps",
                "startTime": 1714377600000,
                "endTime": 1714381200000,
                "totalAmount": 500,
                "paymentMethod": "cash",
                "sales": [{"amount": 500, "paymentMethod": "cash", "label": "Старт", "time": 1714377600000}],
            }],
        },
    }, "2026-04-29", "2026-04-29")
    ensure(session_rows and session_rows[0]["stationName"] == "Симулятор A", "report rows should use station name from settings definitions")
    ensure(session_rows and session_rows[0]["stationType"] == "Симулятор гонок", "report rows should use station type from settings definitions")
    ensure(sales_rows and sales_rows[0]["stationName"] == "Симулятор A", "sales rows should use station name from settings definitions")
    checks.append("report-station-metadata")

    mixed_state = {
        "settings": {
            "graceMinutes": 10,
            "overdueMinutes": 30,
            "stationDefinitions": [
                {"id": 1, "name": "PS1", "type": "ps"},
            ],
        },
        "sessions": {
            "2026-04-29": [{
                "stationId": 1,
                "stationName": "PS1",
                "stationType": "ps",
                "startTime": 1714377600000,
                "endTime": 1714381200000,
                "totalAmount": 600,
                "paymentMethod": "cash",
                "sales": [
                    {"amount": 300, "paymentMethod": "cash", "label": "Старт", "time": 1714377600000},
                    {"amount": 300, "paymentMethod": "card", "label": "Продление", "time": 1714379400000},
                ],
            }],
        },
    }
    mixed_session_rows, mixed_sales_rows, _ = psl_main._collect_report_rows(mixed_state, "2026-04-29", "2026-04-29", "", "mixed")
    ensure(len(mixed_session_rows) == 1, "mixed payment filter should keep the mixed session")
    ensure(len(mixed_sales_rows) == 2, "mixed payment filter should keep all sales from the mixed session")
    cash_session_rows, cash_sales_rows, _ = psl_main._collect_report_rows(mixed_state, "2026-04-29", "2026-04-29", "", "cash")
    ensure(len(cash_session_rows) == 1, "cash payment filter should keep sessions that include a cash sale")
    ensure(len(cash_sales_rows) == 1 and cash_sales_rows[0]["_paymentRaw"] == "cash", "cash payment filter should keep only cash sales")
    card_session_rows, card_sales_rows, _ = psl_main._collect_report_rows(mixed_state, "2026-04-29", "2026-04-29", "", "card")
    ensure(len(card_session_rows) == 1, "card payment filter should keep sessions that include a card sale")
    ensure(len(card_sales_rows) == 1 and card_sales_rows[0]["_paymentRaw"] == "card", "card payment filter should keep only card sales")
    checks.append("report-payment-filters")

    export_shape_state = {
        "settings": {
            "graceMinutes": 10,
            "overdueMinutes": 30,
            "stationDefinitions": [
                {"id": 1, "name": "PS1", "type": "ps"},
                {"id": 2, "name": "PS2", "type": "ps"},
                {"id": 3, "name": "PS3", "type": "ps"},
                {"id": 4, "name": "PS4", "type": "ps"},
                {"id": 5, "name": "Arcade Racer", "type": "simulator"},
                {"id": 6, "name": "Nintendo Switch", "type": "switch"},
                {"id": 7, "name": "VIP Hall", "type": "simulator"},
            ],
        },
        "sessions": {
            "2026-04-29": [{
                "stationId": 7,
                "stationName": "VIP Hall",
                "stationType": "simulator",
                "startTime": 1714377600000,
                "endTime": 1714381200000,
                "totalAmount": 700,
                "paymentMethod": "cash",
                "sales": [{"amount": 700, "minutes": 60, "paymentMethod": "cash", "label": "Старт", "time": 1714377600000}],
            }],
        },
    }
    export_session_rows, export_sales_rows, export_keys = psl_main._collect_report_rows(export_shape_state, "2026-04-29", "2026-04-29")
    shift_wb = psl_main._build_shift_workbook("2026-04-29", export_session_rows, export_sales_rows, export_shape_state)
    report_wb = psl_main._build_report_workbook("2026-04-29", "2026-04-29", export_session_rows, export_sales_rows, export_keys, export_shape_state)
    ensure(shift_wb.active["A19"].value == "VIP Hall", "shift workbook should include extra station rows from settings")
    ensure(report_wb.worksheets[0]["H14"].value == "VIP Hall", "report workbook should include extra station rows from settings")
    checks.append("export-station-shaping")

    response = client.get("/api/backup")
    payload = response.get_json(silent=True) or {}
    if response.status_code == 200:
      ensure(isinstance(payload, dict), "backup payload is not an object")
      ensure("stations" in payload and "sessions" in payload, "backup payload missing stations/sessions")
      ensure("achievements" in payload, "backup payload missing achievements")
      response = client.post("/api/backup", json={
          "lastModified": True,
          "stations": payload.get("stations"),
          "sessions": payload.get("sessions"),
          "settings": payload.get("settings"),
          "achievements": payload.get("achievements"),
      })
      bad_payload = response.get_json(silent=True) or {}
      ensure(response.status_code == 400, f"/api/backup should reject bool lastModified, got {response.status_code}")
      ensure(bad_payload.get("error") == "lastModified must be int", f"/api/backup wrong bool lastModified error: {bad_payload}")
      checks.append("backup-bool-lastModified")
    else:
      ensure(response.status_code == 403 and payload.get("error") == "license_required", f"/api/backup unexpected response {response.status_code}")
    checks.append("backup")

    print(f"[ok] backend smoke check passed: {', '.join(checks)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"[fail] {exc}", file=sys.stderr)
        raise SystemExit(1)
