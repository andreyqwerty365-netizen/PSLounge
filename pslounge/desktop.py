# -*- coding: utf-8 -*-
from __future__ import annotations

import ctypes
import os
import socket
import threading
import time
import webbrowser

try:
    import fcntl
except Exception:  # pragma: no cover - non-POSIX fallback
    fcntl = None

from .constants import (
    APP_NAME,
    INSTANCE_LOCK_FILE,
    MUTEX_NAME,
    URL_SHORTCUT_MACOS,
    URL_SHORTCUT_WINDOWS,
    URL_TXT,
)
from .licensing import _platform_tag
from .paths import _app_dir, log
from .web import app


def _open_existing_instance_from_url_file() -> None:
    url_path = _app_dir() / URL_TXT
    url = ""
    if url_path.exists():
        url = url_path.read_text(encoding="utf-8", errors="ignore").strip()

    if not url:
        return

    try:
        import urllib.request

        health_url = url.rstrip("/") + "/health"
        with urllib.request.urlopen(health_url, timeout=0.5) as r:
            body = (r.read(64) or b"").decode("utf-8", errors="ignore")
        if "OK:PSLOUNGE" in body:
            webbrowser.open(url)
        else:
            log(f"Existing URL does not look like PS Lounge: {health_url} -> {body!r}")
    except Exception as e:
        log(f"Failed to verify/open existing URL: {e!r}")


def _acquire_posix_instance_lock(open_existing: bool = True) -> None:
    if fcntl is None:
        return
    lock_path = _app_dir() / INSTANCE_LOCK_FILE
    try:
        lock_file = lock_path.open("a+", encoding="utf-8")
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(str(os.getpid()))
        lock_file.flush()
        globals()["_PSLOUNGE_INSTANCE_LOCK"] = lock_file
    except BlockingIOError:
        log("Another instance is already running. Exiting.")
        if open_existing:
            _open_existing_instance_from_url_file()
        raise SystemExit(0)
    except SystemExit:
        raise
    except Exception as e:
        log(f"POSIX single-instance lock failed: {e!r}")


def ensure_single_instance(open_existing: bool = True) -> None:
    """Prevent multiple desktop instances on supported platforms."""
    if os.name == "nt":
        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            mutex = kernel32.CreateMutexW(None, True, MUTEX_NAME)
            # Keep a reference so it isn't GC'ed
            globals()["_PSLOUNGE_MUTEX"] = mutex
            last_err = kernel32.GetLastError()
            ERROR_ALREADY_EXISTS = 183
            if last_err == ERROR_ALREADY_EXISTS:
                log("Another instance is already running. Exiting.")
                if open_existing:
                    _open_existing_instance_from_url_file()
                raise SystemExit(0)
        except SystemExit:
            raise
        except Exception as e:
            # If mutex fails, don't block app start; just log.
            log(f"Single-instance mutex failed: {e!r}")
        return
    _acquire_posix_instance_lock(open_existing=open_existing)


def port_in_use(host: str, port: int) -> bool:
    """Return True if a TCP server is already listening on host:port.

    Uses connect_ex (reliable on Windows even when another process binds 0.0.0.0:port).
    """
    check_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex((check_host, port)) == 0
    except Exception:
        # If we cannot check, assume it's in use to be safe.
        return True


def _can_bind(host: str, port: int) -> bool:
    """Best-effort check that we can bind host:port."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
        return True
    except OSError:
        return False


def pick_port(host: str, preferred: int) -> int:
    """Prefer preferred; fall back to a free ephemeral port."""
    if not port_in_use(host, preferred) and _can_bind(host, preferred):
        return preferred

    # Ask OS for a free port on the target host
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def _url_shortcut_name() -> str:
    if _platform_tag() == "macos":
        return URL_SHORTCUT_MACOS
    if _platform_tag() == "windows":
        return URL_SHORTCUT_WINDOWS
    return ""


def _url_shortcut_content(url: str) -> str:
    if _platform_tag() == "windows":
        return "[InternetShortcut]\nURL={}\n".format(url)
    if _platform_tag() == "macos":
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0">\n'
            "<dict>\n"
            f"\t<key>URL</key>\n\t<string>{url}</string>\n"
            "</dict>\n"
            "</plist>\n"
        )
    return ""


def write_url_files(url: str) -> None:
    d = _app_dir()
    try:
        (d / URL_TXT).write_text(url, encoding="utf-8")
    except Exception as e:
        log(f"Failed to write {URL_TXT}: {e!r}")

    shortcut_name = _url_shortcut_name()
    shortcut_content = _url_shortcut_content(url)
    if not shortcut_name or not shortcut_content:
        return

    try:
        (d / shortcut_name).write_text(shortcut_content, encoding="utf-8")
    except Exception as e:
        log(f"Failed to write {shortcut_name}: {e!r}")


def main() -> None:
    ensure_single_instance(open_existing=True)

    host = os.environ.get("PS_LOUNGE_HOST", "127.0.0.1")
    preferred_port = int(os.environ.get("PS_LOUNGE_PORT", "5000"))
    debug = os.environ.get("PS_LOUNGE_DEBUG", "0") == "1"
    no_browser = os.environ.get("PS_LOUNGE_NO_BROWSER", "0") == "1"

    if port_in_use(host, preferred_port) or not _can_bind(host, preferred_port):
        log(f"Preferred port {preferred_port} is busy; selecting a free port")
    port = pick_port(host, preferred_port)
    url = f"http://{host}:{port}/"

    log(f"Starting {APP_NAME} on {url} (preferred {preferred_port})")
    write_url_files(url)

    # Open browser once on start.
    if not no_browser:
        if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
            threading.Thread(
                target=lambda: (time.sleep(0.6), webbrowser.open(url)), daemon=True
            ).start()

    # A production WSGI server works on Windows and never starts a reloader.
    from waitress import serve

    app.debug = debug
    serve(app, host=host, port=port, threads=4)
