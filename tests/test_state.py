from concurrent.futures import ThreadPoolExecutor
import json
import threading

import pytest

from pslounge import state, web
from pslounge.constants import STATE_BAK_FILE, STATE_FILE, STATE_HISTORY_DIR


def payload(version=1):
    return {
        "lastModified": version,
        "stations": [{"id": 1, "status": "idle", "stationType": "ps"}],
        "sessions": {},
        "settings": None,
        "achievements": None,
    }


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(state, "_app_dir", lambda: tmp_path)
    monkeypatch.setattr(web, "_app_dir", lambda: tmp_path)
    # Persistence tests isolate authorization; no production license is created.
    monkeypatch.setattr(web, "_require_license", lambda: None)
    monkeypatch.setenv("PS_LOUNGE_RETENTION_DAYS", "9999")
    return tmp_path


def test_corrupt_primary_preserves_backup_and_recovers(isolated):
    backup = isolated / STATE_BAK_FILE
    backup.write_text(json.dumps(payload(1)))
    primary = isolated / STATE_FILE
    primary.write_text("{broken")
    assert state._read_state_file()["source"] == "backup"
    state._atomic_write_json(primary, payload(2))
    assert json.loads(backup.read_text())["lastModified"] == 1
    primary.write_text("{broken-again")
    assert state._read_state_file()["lastModified"] == 1


def test_snapshot_recovery_skips_invalid_newest(isolated):
    history = isolated / STATE_HISTORY_DIR
    history.mkdir()
    (history / "2026-09-29.json").write_text(json.dumps(payload(3)))
    (history / "2026-09-30.json").write_text("{broken")
    recovered = state._read_state_file()
    assert recovered["source"] == "snapshot"
    assert recovered["lastModified"] == 3
    assert recovered["recoveryDiagnostics"]["fallbackUsed"] is True


def test_parallel_posts_keep_newest_state(isolated):
    barrier = threading.Barrier(12)

    def post(version):
        with web.app.test_client() as client:
            barrier.wait(timeout=10)
            response = client.post("/api/backup", json=payload(version))
            assert response.status_code == 200
            assert response.get_json()["ok"] is True

    with ThreadPoolExecutor(max_workers=12) as executor:
        list(executor.map(post, range(1, 13)))
    assert state._read_state_file()["lastModified"] == 12
    assert not list(isolated.rglob("*.tmp"))


def test_failed_replace_leaves_primary_intact(isolated, monkeypatch):
    target = isolated / STATE_FILE
    state._atomic_write_json(target, payload(1))
    with pytest.raises(ValueError):
        state._replace_json(target, {"invalid": float("nan")})
    assert json.loads(target.read_text())["lastModified"] == 1
    assert not list(isolated.glob("*.tmp"))


def test_bool_timestamp_rejected_on_disk_and_api(isolated):
    assert not state._is_valid_state_payload(payload(True))
    with web.app.test_client() as client:
        assert client.post("/api/backup", json=payload(True)).status_code == 400


def test_license_activation_rejects_non_object_json():
    with web.app.test_client() as client:
        response = client.post("/api/license/activate", json=["token"])
        assert response.status_code == 400
        assert response.get_json()["error"] == "bad json"


def test_non_finite_session_values_are_bad_requests(isolated):
    data = payload()
    data["stations"][0]["startTime"] = float("nan")
    with web.app.test_client() as client:
        response = client.post("/api/backup", json=data)
    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid_state_shape"
    assert not (isolated / STATE_FILE).exists()
