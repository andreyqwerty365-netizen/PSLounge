from pathlib import Path

import pytest

from pslounge import paths
from pslounge.constants import LICENSE_FILE, STATE_BAK_FILE, STATE_FILE


def test_source_directory_remains_project_root(monkeypatch):
    monkeypatch.delenv("PS_LOUNGE_DATA_DIR", raising=False)
    monkeypatch.delattr(paths.sys, "frozen", raising=False)
    assert paths._app_dir() == Path(paths.__file__).resolve().parents[1]


def test_data_override_does_not_redirect_resources(monkeypatch, tmp_path):
    directory = tmp_path / "data"
    monkeypatch.setenv("PS_LOUNGE_DATA_DIR", str(directory))
    monkeypatch.delattr(paths.sys, "frozen", raising=False)
    assert paths._app_dir() == directory
    assert directory.is_dir()
    assert paths._resource_path("static") != str(directory / "static")


def test_windows_upgrade_preserves_originals_and_newer_data(monkeypatch, tmp_path):
    portable = tmp_path / "portable"
    portable.mkdir()
    (portable / STATE_FILE).write_text("legacy-state", encoding="utf-8")
    (portable / STATE_BAK_FILE).write_text("legacy-backup", encoding="utf-8")
    (portable / LICENSE_FILE).write_text("signed-public-licence", encoding="utf-8")
    (portable / "license_private_key.json").write_text("do-not-copy", encoding="utf-8")
    (portable / "state_history").mkdir()
    (portable / "state_history" / "2026-01-01.json").write_text(
        "snapshot", encoding="utf-8"
    )
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(paths.sys, "platform", "win32")
    monkeypatch.setattr(paths.sys, "executable", str(portable / "PS Lounge.exe"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.delenv("PS_LOUNGE_DATA_DIR", raising=False)

    directory = paths._app_dir()
    assert directory == tmp_path / "local" / "PS Lounge"
    assert (directory / STATE_FILE).read_text(encoding="utf-8") == "legacy-state"
    assert (directory / LICENSE_FILE).read_text(
        encoding="utf-8"
    ) == "signed-public-licence"
    assert (directory / STATE_BAK_FILE).read_text() == "legacy-backup"
    assert not (directory / "license_private_key.json").exists()
    assert (directory / "state_history" / "2026-01-01.json").read_text() == "snapshot"
    (directory / STATE_FILE).write_text("new-state", encoding="utf-8")
    paths._app_dir()
    assert (directory / STATE_FILE).read_text() == "new-state"
    assert (portable / STATE_FILE).read_text() == "legacy-state"


def test_migration_does_not_follow_symlinks(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    private = tmp_path / "private"
    private.write_text("private")
    try:
        (source / STATE_FILE).symlink_to(private)
    except OSError:
        pytest.skip("Creating symlinks requires privileges on this platform")
    paths._migrate_legacy_data(source, target)
    assert not (target / STATE_FILE).exists()


def test_bundled_resources_are_independent_from_windows_data(monkeypatch, tmp_path):
    bundle = tmp_path / "_internal"
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(paths.sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setenv("PS_LOUNGE_DATA_DIR", str(tmp_path / "data"))
    assert paths._resource_path("templates", "index.html") == str(
        bundle / "templates" / "index.html"
    )
