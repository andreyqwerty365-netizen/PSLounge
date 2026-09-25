from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


BASE_URL = os.environ.get("PS_LOUNGE_URL", "http://127.0.0.1:5000").rstrip("/")


def fetch(path: str):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return response.status, dict(response.headers.items()), body
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers.items()), exc.read()


def ensure(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)


def main() -> int:
    checks: list[str] = []

    status, headers, body = fetch("/health")
    ensure(status == 200, f"/health returned {status}")
    ensure(body.decode("utf-8", errors="replace") == "OK:PSLOUNGE", "/health body mismatch")
    checks.append("health")

    status, headers, body = fetch("/")
    html = body.decode("utf-8", errors="replace")
    ensure(status == 200, f"/ returned {status}")
    ensure("PS Lounge" in html, "main page title marker missing")
    ensure("/static/styles.css?v=" in html, "styles.css cache-busting parameter missing")
    ensure("/static/app.js?v=" in html, "app.js cache-busting parameter missing")
    checks.append("index")

    status, headers, body = fetch("/api/license/status")
    ensure(status == 200, f"/api/license/status returned {status}")
    payload = json.loads(body.decode("utf-8", errors="replace") or "{}")
    ensure("licensed" in payload, "license status payload missing 'licensed'")
    checks.append("license")

    status, headers, body = fetch("/api/backup")
    if status == 200:
        payload = json.loads(body.decode("utf-8", errors="replace") or "{}")
        ensure(isinstance(payload, dict), "backup payload is not an object")
        ensure("stations" in payload and "sessions" in payload, "backup payload missing stations/sessions")
    else:
        payload = json.loads(body.decode("utf-8", errors="replace") or "{}")
        ensure(status == 403 and payload.get("error") == "license_required", f"/api/backup unexpected response {status}")
    checks.append("backup")

    print(f"[ok] backend smoke check passed: {', '.join(checks)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"[fail] {exc}", file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as exc:
        print(f"[fail] Сервер PS Lounge недоступен по адресу {BASE_URL}: {exc.reason}", file=sys.stderr)
        print("[hint] Сначала запустите приложение через run.bat или run_py.bat.", file=sys.stderr)
        raise SystemExit(1)
