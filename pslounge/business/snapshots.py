"""JSON-compatible state inside SQLite, with an immutable payment ledger."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from decimal import Decimal, ROUND_HALF_UP

from ..state import _default_state, _is_valid_state_payload
from .database import BusinessError, audit, encode, insert_payment, money, now


def normalize(data, *, legacy=False):
    value = deepcopy(data)
    for day, records in (value.get("sessions") or {}).items():
        for index, record in enumerate(records):
            record.setdefault(
                "id",
                "legacy-"
                + hashlib.sha256(
                    f"{day}:{index}:{record.get('stationId')}:{record.get('startTime')}".encode()
                ).hexdigest()[:24],
            )
            if not record.get("sales") and money(record.get("totalAmount") or 0) > 0:
                record["sales"] = [
                    {
                        "id": "legacy-total",
                        "time": record.get("startTime") or now(),
                        "type": "legacy",
                        "label": "Историческая оплата",
                        "minutes": 0,
                        "amount": record["totalAmount"],
                        "paymentMethod": record.get("paymentMethod") or "cash",
                    }
                ]
            for sale_index, sale in enumerate(record.get("sales") or []):
                sale.setdefault("id", f"legacy-sale-{sale_index}")
            if legacy:
                total = sum(
                    money(sale.get("amount", 0)) for sale in record.get("sales") or []
                )
                if money(record.get("totalAmount") or 0) != total:
                    record["legacyReportedTotal"] = record.get("totalAmount")
                    record["totalAmount"] = total / 100
    return value


def ingest(conn, data, user, *, imported=False, trusted_pass=False):
    seen = set()
    for day, records in (data.get("sessions") or {}).items():
        for record in records:
            amounts = 0
            for sale in record.get("sales") or []:
                source = f"game:{record['id']}:{sale['id']}"
                if source in seen:
                    raise BusinessError("duplicate_sale", 409)
                seen.add(source)
                cents = money(sale.get("amount", 0))
                amounts += cents
                method = (
                    sale.get("paymentMethod") or record.get("paymentMethod") or "cash"
                )
                old = conn.execute(
                    "SELECT * FROM payments WHERE source_key=?", (source,)
                ).fetchone()
                details = {
                    "sessionId": record["id"],
                    "stationId": record.get("stationId"),
                    "day": day,
                    "sale": sale,
                }
                if old:
                    # Editing a historical sale is never a financial correction.
                    saved_sale = json.loads(old["details"])["sale"]
                    if (
                        old["amount_cents"] != cents
                        or old["method"] != method
                        or saved_sale != sale
                    ):
                        raise BusinessError("payment_immutable", 409)
                else:
                    if not imported:
                        if sale.get("type") == "pass_minutes" and not trusted_pass:
                            raise BusinessError("pass_command_required", 403)
                        if (
                            user["role"] != "owner"
                            and sale.get("type") != "pass_minutes"
                        ):
                            validate_operator_price(data, record, sale, cents)
                    insert_payment(
                        conn,
                        user,
                        "game",
                        cents,
                        method,
                        source=source,
                        details=details,
                        imported=imported,
                    )
            if money(record.get("totalAmount") or 0) != amounts:
                raise BusinessError("session_total_mismatch", 409)


def initialize(db, legacy_supplier):
    with db.transaction() as conn:
        if conn.execute("SELECT 1 FROM snapshots").fetchone():
            return
        legacy = legacy_supplier()
        if _is_valid_state_payload(legacy):
            value = normalize(legacy, legacy=True)
            ingest(conn, value, None, imported=True)
            revision = 1
            audit(
                conn,
                None,
                "legacy_migration",
                {
                    "source": legacy.get("source"),
                    "lastModified": legacy.get("lastModified"),
                },
            )
            # Original JSON/backup/history files remain untouched for rollback.
        else:
            value, revision = _default_state(), 0
        conn.execute("INSERT INTO snapshots VALUES(1,?,?)", (revision, encode(value)))
        conn.execute(
            "INSERT INTO snapshot_history VALUES(?,?,?,NULL)",
            (revision, encode(value), now()),
        )


def load(conn):
    row = conn.execute("SELECT * FROM snapshots WHERE id=1").fetchone()
    value = json.loads(row["data"]) if row else _default_state()
    value["revision"] = row["revision"] if row else 0
    value["source"] = "database"
    return value


def persist(conn, value, user):
    current = load(conn)
    revision = current["revision"] + 1
    value = deepcopy(value)
    value.pop("revision", None)
    value.pop("baseRevision", None)
    conn.execute(
        "UPDATE snapshots SET revision=?,data=? WHERE id=1", (revision, encode(value))
    )
    conn.execute(
        "INSERT INTO snapshot_history VALUES(?,?,?,?)",
        (revision, encode(value), now(), user["id"]),
    )
    # Retain recent recovery snapshots; full financial/session history stays in the current state and ledger.
    conn.execute("DELETE FROM snapshot_history WHERE revision < ?", (revision - 30,))
    return {"ok": True, "revision": revision}


def save(conn, data, user):
    current = load(conn)
    if (
        isinstance(data.get("baseRevision"), bool)
        or data.get("baseRevision") != current["revision"]
    ):
        raise BusinessError(
            "revision_conflict", 409, currentRevision=current["revision"]
        )
    if not _is_valid_state_payload(data):
        raise BusinessError("invalid_state_shape")
    if user["role"] != "owner" and data.get("settings") != current.get("settings"):
        raise BusinessError("owner_required", 403)
    value = normalize(data)
    all_records = [
        record
        for records in (value.get("sessions") or {}).values()
        for record in records
    ]
    identifiers = [record["id"] for record in all_records]
    if len(set(identifiers)) != len(identifiers):
        raise BusinessError("duplicate_session", 409)
    incoming = {
        record["id"]: record
        for records in (value.get("sessions") or {}).values()
        for record in records
    }
    for day, records in (current.get("sessions") or {}).items():
        for old in records:
            fresh = incoming.get(old["id"])
            if fresh is None:
                value.setdefault("sessions", {}).setdefault(day, []).append(old)
            else:
                if fresh.get("stationId") != old.get("stationId") or fresh.get(
                    "startTime"
                ) != old.get("startTime"):
                    raise BusinessError("session_immutable", 409)
                if not any(
                    rec["id"] == old["id"]
                    for rec in (value.get("sessions") or {}).get(day, [])
                ):
                    raise BusinessError("session_immutable", 409)
                old_sales = {sale["id"]: sale for sale in old.get("sales") or []}
                fresh_sales = {sale["id"]: sale for sale in fresh.get("sales") or []}
                if any(fresh_sales.get(key) != sale for key, sale in old_sales.items()):
                    raise BusinessError("payment_immutable", 409)
    importing = current["revision"] == 0 and user["role"] == "owner"
    ingest(conn, value, user, imported=importing)
    value["lastModified"] = max(
        now(),
        int(current.get("lastModified") or 0) + 1,
        int(value.get("lastModified") or 0),
    )
    audit(conn, user, "state_saved", {"baseRevision": current["revision"]})
    return persist(conn, value, user)


def validate_operator_price(data, record, sale, cents):
    settings = data.get("settings") or {}
    station_type = record.get("stationType") or "ps"
    definition = next(
        (
            item
            for item in settings.get("stationDefinitions") or []
            if item.get("id") == record.get("stationId")
        ),
        None,
    )
    if not definition or definition.get("type") != station_type:
        raise BusinessError("station_type_immutable", 403)
    minutes = sale.get("minutes")
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes <= 0:
        raise BusinessError("invalid_quantity")
    if sale.get("type") in ("start_tariff", "extend_tariff"):
        tariffs = (settings.get("tariffGroups") or {}).get(station_type) or []
        tariff = next(
            (item for item in tariffs if item.get("id") == sale.get("tariffId")), None
        )
        if (
            not tariff
            or tariff.get("minutes") != minutes
            or money(tariff.get("price")) != cents
        ):
            raise BusinessError("tariff_price_changed", 409)
    elif sale.get("type") in ("start_custom", "extend_custom", "extend_paid_minutes"):
        rate = (settings.get("customRates") or {}).get(station_type)
        if rate is None:
            raise BusinessError("tariff_price_changed", 409)
        expected = (Decimal(money(rate)) * minutes / 6000).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
        if int(expected) * 100 != cents:
            raise BusinessError("tariff_price_changed", 409)
    else:
        raise BusinessError("invalid_sale_type", 403)
