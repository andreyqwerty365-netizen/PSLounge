# -*- coding: utf-8 -*-
from __future__ import annotations

from datetime import datetime

from .formatting import (
    _format_date_ru,
    _hhmm,
    _minutes_label,
    _money_int,
    _normalize_payment_method,
    _normalize_station_type_key,
    _payment_label,
    _safe_int,
    _station_name,
    _station_type_label,
)


def _normalize_station_definition(defn: object, idx: int) -> dict | None:
    if not isinstance(defn, dict):
        return None
    raw_id = _safe_int(defn.get("id"), idx + 1)
    station_type = _normalize_station_type_key(defn.get("type"), "ps")
    name = str(defn.get("name") or _station_name(raw_id, station_type)).strip()
    if raw_id <= 0 or not name:
        return None
    return {"id": raw_id, "name": name, "type": station_type}


def _state_station_definitions(state: dict | None) -> list[dict]:
    settings = state.get("settings") if isinstance(state, dict) else None
    raw_defs = (
        settings.get("stationDefinitions") if isinstance(settings, dict) else None
    )
    if isinstance(raw_defs, list):
        defs = []
        for idx, item in enumerate(raw_defs):
            normalized = _normalize_station_definition(item, idx)
            if normalized is not None:
                defs.append(normalized)
        if defs:
            return defs
    stations = state.get("stations") if isinstance(state, dict) else None
    defs = []
    if isinstance(stations, list):
        for idx, item in enumerate(stations):
            if not isinstance(item, dict):
                continue
            sid = _safe_int(item.get("id"), idx + 1)
            stype = _normalize_station_type_key(
                item.get("stationType"),
                "simulator" if sid == 5 else "switch" if sid == 6 else "ps",
            )
            defs.append(
                {
                    "id": sid,
                    "name": str(item.get("name") or _station_name(sid, stype)).strip(),
                    "type": stype,
                }
            )
    return defs


def _report_station_names(
    state: dict | None, session_rows: list[dict], sales_rows: list[dict]
) -> list[str]:
    names = []
    seen = set()
    for item in _state_station_definitions(state):
        name = str(item.get("name") or "").strip()
        if name and name not in seen:
            names.append(name)
            seen.add(name)
    for row in [*session_rows, *sales_rows]:
        name = str(row.get("stationName") or "").strip()
        if name and name not in seen:
            names.append(name)
            seen.add(name)
    return names


def _is_valid_sale_item(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("minutes") is not None and not isinstance(
        value.get("minutes"), (int, float)
    ):
        return False
    if value.get("amount") is not None and not isinstance(
        value.get("amount"), (int, float)
    ):
        return False
    if value.get("time") is not None and not isinstance(
        value.get("time"), (int, float)
    ):
        return False
    return True


def _is_valid_session_record(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("stationId") is not None and not isinstance(
        value.get("stationId"), (int, float)
    ):
        return False
    if value.get("startTime") is not None and not isinstance(
        value.get("startTime"), (int, float)
    ):
        return False
    if value.get("endTime") is not None and not isinstance(
        value.get("endTime"), (int, float)
    ):
        return False
    sales = value.get("sales")
    if sales is not None:
        if not isinstance(sales, list):
            return False
        for sale in sales:
            if not _is_valid_sale_item(sale):
                return False
    return True


def _compute_session_duration_minutes(
    rec: dict, paid_minutes_total: int, grace_minutes: int, overdue_minutes: int
) -> tuple[int | None, bool]:
    start_ts = _safe_int(rec.get("startTime"), 0)
    end_ts = _safe_int(rec.get("endTime"), 0)
    if start_ts <= 0 or end_ts <= 0:
        return None, False

    adjusted = False
    if end_ts < start_ts:
        # Defensive correction for sessions that crossed midnight but were persisted on the same logical day.
        if (start_ts - end_ts) <= 24 * 60 * 60 * 1000:
            end_ts += 24 * 60 * 60 * 1000
            adjusted = True
        else:
            return 0, True

    elapsed_minutes = max(0, round((end_ts - start_ts) / 60000))
    if elapsed_minutes <= 0:
        return 0, adjusted

    paid_minutes_total = max(0, _safe_int(paid_minutes_total, 0))
    allowed_overrun = max(0, _safe_int(grace_minutes, 0)) + max(
        0, _safe_int(overdue_minutes, 0)
    )

    if paid_minutes_total > 0:
        hard_cap = max(
            paid_minutes_total + allowed_overrun + 15, round(paid_minutes_total * 1.5)
        )
        if elapsed_minutes > hard_cap:
            return paid_minutes_total, True

    return elapsed_minutes, adjusted


def _build_session_sales_rows(
    rec: dict,
    key: str,
    sid: int,
    stype: str,
    display_station: str,
    display_type: str,
    session_key: str,
) -> tuple[list[dict], int, int, str, str, list[str]]:
    sales_rows: list[dict] = []
    payment_values: list[str] = []
    paid_minutes_total = 0
    fallback_payment = _normalize_payment_method(rec.get("paymentMethod"), "cash")
    fallback_ts = _safe_int(rec.get("startTime"), 0)

    sales = rec.get("sales") if isinstance(rec.get("sales"), list) else []
    for sale in sales:
        if not isinstance(sale, dict):
            continue

        sale_minutes = max(0, _safe_int(sale.get("minutes"), 0))
        sale_amount = _money_int(sale.get("amount"))
        sale_ts = _safe_int(sale.get("time"), fallback_ts) or fallback_ts
        sale_payment = _normalize_payment_method(
            sale.get("paymentMethod"), fallback_payment
        )
        operation = (
            str(sale.get("label") or sale.get("type") or "Начисление").strip()
            or "Начисление"
        )

        if sale_amount <= 0 and sale_minutes <= 0 and operation == "Начисление":
            continue

        paid_minutes_total += sale_minutes
        payment_values.append(sale_payment)

        sales_rows.append(
            {
                "date": _format_date_ru(
                    datetime.fromtimestamp(sale_ts / 1000).strftime("%Y-%m-%d")
                )
                if sale_ts > 0
                else _format_date_ru(key),
                "time": _hhmm(sale_ts) if sale_ts > 0 else "—",
                "stationId": sid,
                "stationName": display_station,
                "stationType": display_type,
                "operation": operation,
                "minutes": sale_minutes,
                "amount": sale_amount,
                "payment": _payment_label(sale_payment),
                "_stationTypeRaw": stype,
                "_paymentRaw": sale_payment,
                "_sessionKey": session_key,
            }
        )

    if sales_rows:
        total_amount = sum(row["amount"] for row in sales_rows)
    else:
        total_amount = _money_int(rec.get("totalAmount"))
        if total_amount > 0:
            sales_rows.append(
                {
                    "date": _format_date_ru(key),
                    "time": _hhmm(fallback_ts) if fallback_ts > 0 else "—",
                    "stationId": sid,
                    "stationName": display_station,
                    "stationType": display_type,
                    "operation": "Продажа",
                    "minutes": 0,
                    "amount": total_amount,
                    "payment": _payment_label(fallback_payment),
                    "_stationTypeRaw": stype,
                    "_paymentRaw": fallback_payment,
                    "_sessionKey": session_key,
                }
            )
            payment_values.append(fallback_payment)

    integrity_flags: list[str] = []
    raw_total_amount = _money_int(rec.get("totalAmount"))
    if raw_total_amount > 0 and sales_rows and raw_total_amount != total_amount:
        integrity_flags.append("sales_total_mismatch")

    if payment_values:
        uniq = []
        for pm in payment_values:
            if pm not in uniq:
                uniq.append(pm)
        payment_raw = uniq[0] if len(uniq) == 1 else "mixed"
        payment_method = _payment_label(uniq[0]) if len(uniq) == 1 else "Смешанная"
    else:
        payment_raw = fallback_payment
        payment_method = _payment_label(payment_raw)

    return (
        sales_rows,
        total_amount,
        paid_minutes_total,
        payment_raw,
        payment_method,
        integrity_flags,
    )


def _collect_report_rows(
    state: dict, from_key: str, to_key: str, station_type: str = "", payment: str = ""
) -> tuple[list[dict], list[dict], list[str]]:
    sessions_map = state.get("sessions") or {}
    settings = state.get("settings") if isinstance(state.get("settings"), dict) else {}
    grace_minutes = max(0, _safe_int(settings.get("graceMinutes"), 0))
    overdue_minutes = max(0, _safe_int(settings.get("overdueMinutes"), 0))
    keys = sorted(k for k in sessions_map.keys() if from_key <= k <= to_key)
    session_rows: list[dict] = []
    sales_rows: list[dict] = []
    station_definitions = {
        item["id"]: item for item in _state_station_definitions(state)
    }
    station_type = _normalize_station_type_key(station_type, "")
    payment = str(payment or "").strip().lower()

    for key in keys:
        for rec_index, rec in enumerate(sessions_map.get(key) or []):
            if not isinstance(rec, dict):
                continue

            sid = _safe_int(rec.get("stationId"), 0)
            configured_station = station_definitions.get(sid) or {}
            stype = _normalize_station_type_key(
                configured_station.get("type")
                or rec.get("stationType")
                or ("racing" if sid == 5 else "switch" if sid == 6 else "ps")
            )
            display_type = _station_type_label(stype)
            display_station = (
                configured_station.get("name")
                or rec.get("stationName")
                or _station_name(sid, stype)
            )

            session_key = f"{key}|{sid}|{_safe_int(rec.get('startTime'), 0)}|{_safe_int(rec.get('endTime'), 0)}|{rec_index}"
            (
                session_sales_rows,
                total_amount,
                paid_minutes_total,
                payment_raw,
                payment_method,
                integrity_flags,
            ) = _build_session_sales_rows(
                rec, key, sid, stype, display_station, display_type, session_key
            )
            sales_rows.extend(session_sales_rows)

            duration_minutes, duration_adjusted = _compute_session_duration_minutes(
                rec,
                paid_minutes_total,
                grace_minutes,
                overdue_minutes,
            )

            row = {
                "date": _format_date_ru(key),
                "stationId": sid,
                "stationName": display_station,
                "stationType": display_type,
                "paidTime": _minutes_label(paid_minutes_total),
                "start": _hhmm(rec.get("startTime")),
                "finish": _hhmm(rec.get("endTime")) if rec.get("endTime") else "—",
                "duration": _minutes_label(duration_minutes)
                if duration_minutes is not None
                else "Активна",
                "sum": total_amount,
                "payment": payment_method,
                "close": "идёт"
                if not rec.get("endTime")
                else ("авто" if rec.get("mode") == "auto" else "вручную"),
                "_stationTypeRaw": stype,
                "_paymentRaw": payment_raw,
                "_paidMinutes": paid_minutes_total,
                "_endTime": rec.get("endTime"),
                "_startTime": rec.get("startTime"),
                "_durationMinutes": duration_minutes or 0,
                "_durationAdjusted": duration_adjusted,
                "_integrityFlags": integrity_flags
                + (["duration_adjusted"] if duration_adjusted else []),
                "_sessionKey": session_key,
            }
            session_rows.append(row)

    if station_type and station_type != "all":
        session_rows = [r for r in session_rows if r["_stationTypeRaw"] == station_type]
        sales_rows = [r for r in sales_rows if r["_stationTypeRaw"] == station_type]
    if payment and payment != "all":
        if payment == "mixed":
            session_rows = [r for r in session_rows if r["_paymentRaw"] == "mixed"]
            matching_session_keys = {r["_sessionKey"] for r in session_rows}
            sales_rows = [
                r for r in sales_rows if r["_sessionKey"] in matching_session_keys
            ]
        else:
            sales_rows = [r for r in sales_rows if r["_paymentRaw"] == payment]
            matching_session_keys = {r["_sessionKey"] for r in sales_rows}
            session_rows = [
                r
                for r in session_rows
                if r["_paymentRaw"] == payment
                or r["_sessionKey"] in matching_session_keys
            ]

    return session_rows, sales_rows, keys
