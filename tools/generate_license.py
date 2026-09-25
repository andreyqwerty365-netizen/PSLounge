from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

LICENSE_PRODUCT = "pslounge-desktop"
DEFAULT_SEAT_TYPE = "single_device"
DEFAULT_LEDGER_FILE = Path(__file__).with_name("license_ledger.csv")
DEFAULT_PRIVATE_KEY_FILE = Path(__file__).with_name("license_private_key.json")


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def load_private_key() -> tuple[str, str]:
    modulus = os.environ.get("PS_LOUNGE_PRIVATE_MODULUS_B64", "").strip()
    private_exponent = os.environ.get("PS_LOUNGE_PRIVATE_D_B64", "").strip()
    if modulus and private_exponent:
        return modulus, private_exponent

    key_path = Path(os.environ.get("PS_LOUNGE_LICENSE_PRIVATE_KEY_FILE", "") or DEFAULT_PRIVATE_KEY_FILE)
    if key_path.exists():
        payload = json.loads(key_path.read_text(encoding="utf-8"))
        modulus = str(payload.get("privateModulusB64") or "").strip()
        private_exponent = str(payload.get("privateDB64") or "").strip()
        if modulus and private_exponent:
            return modulus, private_exponent

    raise RuntimeError(
        "license_private_key_missing: copy license_private_key.example.json to "
        "license_private_key.json and fill in the signing key"
    )


def sign_token(payload_segment: str) -> str:
    modulus_b64, private_exponent_b64 = load_private_key()
    modulus = int.from_bytes(base64.b64decode(modulus_b64), "big")
    private_exponent = int.from_bytes(base64.b64decode(private_exponent_b64), "big")
    digest = hashlib.sha256(payload_segment.encode("ascii")).digest()
    digest_int = int.from_bytes(digest, "big")
    signature_int = pow(digest_int, private_exponent, modulus)
    signature_bytes = signature_int.to_bytes((modulus.bit_length() + 7) // 8, "big")
    return b64url_encode(signature_bytes)


def build_payload(
    customer: str,
    fingerprint: str,
    license_id: str,
    seat_type: str = DEFAULT_SEAT_TYPE,
    product: str = LICENSE_PRODUCT,
) -> dict:
    return {
        "licenseId": license_id.strip(),
        "seatType": seat_type.strip() or DEFAULT_SEAT_TYPE,
        "product": product.strip() or LICENSE_PRODUCT,
        "customer": customer.strip(),
        "fingerprint": fingerprint.strip().lower(),
        "issuedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def build_token(
    customer: str,
    fingerprint: str,
    license_id: str,
    seat_type: str = DEFAULT_SEAT_TYPE,
    product: str = LICENSE_PRODUCT,
) -> str:
    payload = build_payload(customer, fingerprint, license_id, seat_type=seat_type, product=product)
    payload_segment = b64url_encode(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return f"{payload_segment}.{sign_token(payload_segment)}"


def sanitize_filename_part(value: str) -> str:
    cleaned = "".join(ch for ch in value.strip() if ch not in '\\/:*?"<>|')
    cleaned = "_".join(cleaned.split())
    return cleaned or "license"


def read_request_file(path: str) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("request_file_must_be_json_object")
    return payload


def ensure_parent_dir(path: Path) -> None:
    if path.parent and not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=True)


def append_ledger_entry(ledger_path: Path, row: dict) -> None:
    ensure_parent_dir(ledger_path)
    fieldnames = [
        "issued_at",
        "action",
        "license_id",
        "reissue_from",
        "customer",
        "fingerprint",
        "seat_type",
        "product",
        "output_path",
        "request_file",
    ]
    write_header = not ledger_path.exists() or ledger_path.stat().st_size == 0
    with ledger_path.open("a", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        if write_header:
            writer.writeheader()
        writer.writerow({name: row.get(name, "") for name in fieldnames})


def resolve_input(args: argparse.Namespace) -> tuple[str, str, dict]:
    product = LICENSE_PRODUCT
    fingerprint = str(args.fingerprint or "").strip()
    request_payload: dict = {}
    if args.request_file:
        request_payload = read_request_file(args.request_file)
        fingerprint = str(request_payload.get("machineFingerprint") or request_payload.get("fingerprint") or "").strip()
        product = str(request_payload.get("product") or LICENSE_PRODUCT).strip() or LICENSE_PRODUCT
        if not fingerprint:
            raise SystemExit("request file does not contain machineFingerprint")
    if not fingerprint:
        raise SystemExit("fingerprint is required")
    return fingerprint, product, request_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate offline PS Lounge license token.")
    parser.add_argument("--customer", required=True, help="Customer or company name")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--fingerprint", help="Machine fingerprint from /api/license/status")
    group.add_argument("--request-file", help="Path to activation request file (.psreq)")
    parser.add_argument("--output", help="Optional output file path (.pslkey/.txt/.json)")
    parser.add_argument("--format", choices=("token", "json"), default="token", help="Output format for --output")
    parser.add_argument("--license-id", help="Explicit license identifier. Default: random UUID")
    parser.add_argument("--seat-type", default=DEFAULT_SEAT_TYPE, help="Seat type label stored in the license payload")
    parser.add_argument("--reissue-license-id", help="Existing licenseId being reissued for a new machine")
    parser.add_argument("--ledger-file", help="Optional path to seller-side license ledger CSV")
    args = parser.parse_args()

    fingerprint, product, request_payload = resolve_input(args)
    license_id = (args.license_id or str(uuid.uuid4())).strip()
    if not license_id:
        raise SystemExit("license id cannot be empty")
    seat_type = str(args.seat_type or DEFAULT_SEAT_TYPE).strip() or DEFAULT_SEAT_TYPE
    token = build_token(
        args.customer,
        fingerprint,
        license_id,
        seat_type=seat_type,
        product=product,
    )

    if args.output:
        output_path = Path(args.output)
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        name_parts = [sanitize_filename_part(args.customer), sanitize_filename_part(license_id)]
        output_path = Path(f"pslounge_{'_'.join(part for part in name_parts if part)}_{stamp}.pslkey")

    ensure_parent_dir(output_path)
    payload = (
        token
        if args.format == "token"
        else json.dumps(
            {
                **build_payload(args.customer, fingerprint, license_id, seat_type=seat_type, product=product),
                "token": token,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    output_path.write_text(payload, encoding="utf-8")

    ledger_path = Path(args.ledger_file) if args.ledger_file else DEFAULT_LEDGER_FILE
    append_ledger_entry(
        ledger_path,
        {
            "issued_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "action": "reissue" if args.reissue_license_id else "issue",
            "license_id": license_id,
            "reissue_from": str(args.reissue_license_id or "").strip(),
            "customer": args.customer.strip(),
            "fingerprint": fingerprint.strip().lower(),
            "seat_type": seat_type,
            "product": product,
            "output_path": str(output_path.resolve()),
            "request_file": str(Path(args.request_file).resolve()) if args.request_file else "",
        },
    )

    print(token)
    print(f"license_id={license_id}")
    print(f"seat_type={seat_type}")
    print(f"saved={output_path.resolve()}")
    print(f"ledger={ledger_path.resolve()}")


if __name__ == "__main__":
    main()
