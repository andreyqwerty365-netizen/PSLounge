from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main as psl_main  # noqa: E402
import generate_license as license_generator  # noqa: E402


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def decode_json(response) -> dict:
    return response.get_json(silent=True) or {}


def run_generator(args: list[str]) -> dict:
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "generate_license.py"), *args],
        check=True,
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    info: dict[str, str] = {"token": ""}
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            info[key.strip()] = value.strip()
        elif not info["token"]:
            info["token"] = line
    return info


def assert_denied(client, path: str) -> None:
    response = client.get(path)
    payload = decode_json(response)
    ensure(response.status_code == 403, f"{path} should be blocked without license, got {response.status_code}")
    ensure(payload.get("error") == "license_required", f"{path} should return license_required")


def main() -> int:
    checks: list[str] = []
    client = psl_main.app.test_client()
    license_path = Path(psl_main._license_file_path())
    original_bytes = license_path.read_bytes() if license_path.exists() else None
    tmp = ROOT / ".tmp_license_smoke"
    request_file = tmp / "request.psreq"
    token_file = tmp / "license_token.pslkey"
    json_file = tmp / "license_json.json"
    ledger_file = tmp / "license_ledger.csv"

    try:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True, exist_ok=True)
        if license_path.exists():
            license_path.unlink()

        response = client.get("/api/license/status")
        ensure(response.status_code == 200, f"/api/license/status returned {response.status_code}")
        payload = decode_json(response)
        ensure(payload.get("licensed") is False, "license status should start as unlicensed")
        ensure(payload.get("status") == "missing", f"expected missing status, got {payload.get('status')}")
        checks.append("missing-status")

        assert_denied(client, "/api/backup")
        assert_denied(client, "/api/export/today.xlsx")
        assert_denied(client, "/api/export/report.xlsx")
        checks.append("gated-routes")

        fingerprint = str(payload.get("machineFingerprint") or psl_main._machine_fingerprint()).strip()
        label = str(payload.get("machineFingerprintLabel") or psl_main._machine_fingerprint_label()).strip()
        request_payload = {
            "product": "pslounge-desktop",
            "machineFingerprint": fingerprint,
            "machineFingerprintLabel": label,
            "requestedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        request_file.write_text(json.dumps(request_payload, ensure_ascii=False, indent=2), encoding="utf-8")

        issued = run_generator([
            "--customer", "Smoke Customer",
            "--fingerprint", fingerprint,
            "--output", str(token_file),
            "--ledger-file", str(ledger_file),
        ])
        license_id = str(issued.get("license_id") or "").strip()
        token_text = token_file.read_text(encoding="utf-8").strip()
        ensure(token_text == issued.get("token"), "plain token output file mismatch")
        ensure(license_id, "generator did not report license_id")

        run_generator([
            "--customer", "Smoke Customer",
            "--request-file", str(request_file),
            "--format", "json",
            "--output", str(json_file),
            "--ledger-file", str(ledger_file),
            "--license-id", license_id,
            "--reissue-license-id", license_id,
        ])
        json_payload = json.loads(json_file.read_text(encoding="utf-8"))
        ensure(json_payload.get("licenseId") == license_id, "json license payload missing licenseId")
        ensure(json_payload.get("seatType") == "single_device", "json license payload missing seatType")
        ensure(json_payload.get("token"), "json license payload missing token")
        checks.append("generator")

        with ledger_file.open("r", encoding="utf-8-sig", newline="") as fh:
            rows = list(csv.DictReader(fh))
        ensure(len(rows) == 2, f"ledger should contain 2 rows, got {len(rows)}")
        ensure(rows[0].get("action") == "issue", "first ledger row should be issue")
        ensure(rows[1].get("action") == "reissue", "second ledger row should be reissue")
        ensure(rows[1].get("license_id") == license_id, "reissue ledger row should keep license_id")
        checks.append("ledger")

        response = client.post("/api/license/activate", json={"token": token_text})
        payload = decode_json(response)
        ensure(response.status_code == 200, f"activate from token file returned {response.status_code}")
        ensure(payload.get("licensed") is True and payload.get("status") == "active", "token activation did not activate license")
        ensure(payload.get("licenseId") == license_id, "active status missing expected licenseId")
        checks.append("activate-token")

        response = client.get("/api/license/status")
        payload = decode_json(response)
        ensure(payload.get("licensed") is True, "repeat launch status should stay licensed")
        checks.append("repeat-status")

        if license_path.exists():
            license_path.unlink()

        response = client.post("/api/license/activate", json={"token": str(json_payload.get("token") or "")})
        payload = decode_json(response)
        ensure(response.status_code == 200, f"activate from json file token returned {response.status_code}")
        ensure(payload.get("licensed") is True, "json token activation did not activate license")
        checks.append("activate-json")

        if license_path.exists():
            license_path.unlink()

        mismatch_token = license_generator.build_token(
            "Mismatch Customer",
            "0" * 64,
            str(uuid.uuid4()),
            seat_type="single_device",
            product="pslounge-desktop",
        )
        response = client.post("/api/license/activate", json={"token": mismatch_token})
        payload = decode_json(response)
        ensure(response.status_code == 400, f"mismatched token should fail with 400, got {response.status_code}")
        ensure(payload.get("detail") == "fingerprint_mismatch", "mismatched token should report fingerprint_mismatch")
        checks.append("device-mismatch")
    finally:
        if license_path.exists():
            license_path.unlink()
        if original_bytes is not None:
            license_path.write_bytes(original_bytes)
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)

    print(f"[ok] license smoke check passed: {', '.join(checks)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"[fail] {exc}", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as exc:
        print(exc.stdout, file=sys.stderr)
        print(exc.stderr, file=sys.stderr)
        print("[fail] license generator execution failed", file=sys.stderr)
        raise SystemExit(exc.returncode or 1)
