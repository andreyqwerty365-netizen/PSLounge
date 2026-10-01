# -*- coding: utf-8 -*-
from __future__ import annotations

from flask import jsonify
import base64
import hashlib
import os
import platform
import socket
import sys
import json
import re
import uuid
from pathlib import Path
from datetime import datetime
import subprocess

try:
    import winreg
except Exception:  # pragma: no cover - non-Windows fallback for source runs
    winreg = None

from .constants import (
    LICENSE_FILE,
    LICENSE_PRODUCT,
    LICENSE_PUBLIC_EXPONENT_B64,
    LICENSE_PUBLIC_MODULUS_B64,
    LICENSE_SCHEMA_VERSION,
)
from .state import STATE_LOCK, _replace_json
from .paths import _app_dir, log


def _b64url_decode(value: str) -> bytes:
    raw = str(value or "").strip().encode("ascii")
    raw += b"=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw)


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _registry_machine_guid() -> str:
    if winreg is None:
        return ""
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"
        ) as key:
            value, _ = winreg.QueryValueEx(key, "MachineGuid")
            return str(value or "").strip()
    except Exception:
        return ""


def _system_drive_serial() -> str:
    drive = os.environ.get("SystemDrive", "C:").rstrip("\\/")
    try:
        completed = subprocess.run(
            ["cmd", "/c", "vol", drive],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        text = f"{completed.stdout}\n{completed.stderr}"
        match = re.search(r"([A-F0-9]{4}-[A-F0-9]{4})", text, flags=re.IGNORECASE)
        return match.group(1).upper() if match else ""
    except Exception:
        return ""


def _platform_tag() -> str:
    if sys.platform == "darwin":
        return "macos"
    if os.name == "nt":
        return "windows"
    return "linux"


def _mac_platform_uuid() -> str:
    if _platform_tag() != "macos":
        return ""
    try:
        completed = subprocess.run(
            ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        text = f"{completed.stdout}\n{completed.stderr}"
        match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', text)
        return str(match.group(1)).strip() if match else ""
    except Exception:
        return ""


def _linux_machine_id() -> str:
    if _platform_tag() != "linux":
        return ""
    for candidate in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            value = Path(candidate).read_text(encoding="utf-8").strip()
            if value:
                return value
        except Exception:
            continue
    return ""


def _posix_machine_identifier() -> str:
    if _platform_tag() == "macos":
        return _mac_platform_uuid()
    if _platform_tag() == "linux":
        return _linux_machine_id()
    return ""


def _primary_mac_address() -> str:
    try:
        node = int(uuid.getnode())
        if node:
            return f"{node:012x}"
    except Exception:
        pass
    return ""


def _machine_fingerprint_parts() -> list[str]:
    parts = [
        _registry_machine_guid(),
        _system_drive_serial(),
        _posix_machine_identifier(),
        _primary_mac_address(),
        os.environ.get("PROCESSOR_IDENTIFIER", "").strip(),
        platform.machine().strip(),
        socket.gethostname().strip(),
    ]
    return [part for part in parts if part]


def _machine_fingerprint() -> str:
    joined = "|".join(_machine_fingerprint_parts())
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def _machine_fingerprint_label() -> str:
    fp = _machine_fingerprint()
    return f"{fp[:8]}-{fp[8:16]}-{fp[16:24]}"


def _machine_fingerprint_source_health() -> dict[str, object]:
    sources = {
        "registryMachineGuid": bool(_registry_machine_guid()),
        "systemDriveSerial": bool(_system_drive_serial()),
        "platformMachineId": bool(_posix_machine_identifier()),
        "primaryMacAddress": bool(_primary_mac_address()),
        "processorIdentifier": bool(os.environ.get("PROCESSOR_IDENTIFIER", "").strip()),
        "platformMachine": bool(platform.machine().strip()),
        "hostname": bool(socket.gethostname().strip()),
    }
    source_count = sum(1 for available in sources.values() if available)
    return {
        "sources": sources,
        "sourceCount": source_count,
        "stableSourceAvailable": any(
            sources[name]
            for name in (
                "registryMachineGuid",
                "systemDriveSerial",
                "platformMachineId",
                "primaryMacAddress",
            )
        ),
    }


def _license_file_path() -> Path:
    return _app_dir() / LICENSE_FILE


def _license_public_key() -> tuple[int, int]:
    modulus = int.from_bytes(base64.b64decode(LICENSE_PUBLIC_MODULUS_B64), "big")
    exponent = int.from_bytes(base64.b64decode(LICENSE_PUBLIC_EXPONENT_B64), "big")
    return modulus, exponent


def _verify_license_token(token: str) -> dict:
    parts = str(token or "").strip().split(".")
    if len(parts) != 2:
        raise ValueError("invalid_token_format")
    payload_segment, signature_segment = parts
    payload_bytes = _b64url_decode(payload_segment)
    signature_bytes = _b64url_decode(signature_segment)
    payload = json.loads(payload_bytes.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("invalid_payload")
    modulus, exponent = _license_public_key()
    sig_int = int.from_bytes(signature_bytes, "big")
    digest = hashlib.sha256(payload_segment.encode("ascii")).digest()
    expected = int.from_bytes(digest, "big")
    actual = pow(sig_int, exponent, modulus)
    if actual != expected:
        raise ValueError("bad_signature")
    if str(payload.get("product") or "").strip() != LICENSE_PRODUCT:
        raise ValueError("wrong_product")
    return payload


def _read_license_file() -> dict | None:
    path = _license_file_path()
    try:
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        return data
    except Exception as e:
        log(f"Failed to read license file: {e!r}")
        return None


def _write_license_file(data: dict) -> None:
    with STATE_LOCK:
        _replace_json(Path(_license_file_path()), data)


def _license_status() -> dict:
    machine_fp = _machine_fingerprint()
    base = {
        "ok": True,
        "licensed": False,
        "status": "missing",
        "machineFingerprint": machine_fp,
        "machineFingerprintLabel": _machine_fingerprint_label(),
        "fingerprintSourceHealth": _machine_fingerprint_source_health(),
    }
    record = _read_license_file()
    if not record:
        return base
    token = str(record.get("token") or "").strip()
    if not token:
        return {**base, "status": "corrupt", "detail": "empty_token"}
    try:
        payload = _verify_license_token(token)
    except ValueError as e:
        return {**base, "status": "invalid", "detail": str(e)}
    expected_fp = str(payload.get("fingerprint") or "").strip().lower()
    if not expected_fp or expected_fp != machine_fp.lower():
        return {**base, "status": "device_mismatch", "detail": "fingerprint_mismatch"}
    customer = str(payload.get("customer") or "").strip()
    license_id = str(payload.get("licenseId") or "").strip()
    seat_type = (
        str(payload.get("seatType") or "single_device").strip() or "single_device"
    )
    return {
        **base,
        "licensed": True,
        "status": "active",
        "customer": customer,
        "licenseId": license_id,
        "seatType": seat_type,
        "issuedAt": payload.get("issuedAt"),
        "license": {
            "licenseId": license_id,
            "customer": customer,
            "product": payload.get("product"),
            "seatType": seat_type,
            "fingerprint": expected_fp,
        },
    }


def _activate_license_token(token: str) -> dict:
    payload = _verify_license_token(token)
    machine_fp = _machine_fingerprint()
    expected_fp = str(payload.get("fingerprint") or "").strip().lower()
    if not expected_fp:
        raise ValueError("missing_fingerprint")
    if expected_fp != machine_fp.lower():
        raise ValueError("fingerprint_mismatch")
    record = {
        "schemaVersion": LICENSE_SCHEMA_VERSION,
        "product": LICENSE_PRODUCT,
        "token": token.strip(),
        "activatedAt": datetime.now().isoformat(timespec="seconds"),
    }
    _write_license_file(record)
    return _license_status()


def _require_license():
    status = _license_status()
    if status.get("licensed"):
        return None
    return jsonify(
        {
            "ok": False,
            "error": "license_required",
            "license": {
                "status": status.get("status"),
                "detail": status.get("detail", ""),
                "machineFingerprint": status.get("machineFingerprint"),
                "machineFingerprintLabel": status.get("machineFingerprintLabel"),
            },
        }
    ), 403
