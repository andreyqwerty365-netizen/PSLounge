# -*- coding: utf-8 -*-
from __future__ import annotations

import re
from datetime import datetime


def _ru_plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return few
    return many


def _minutes_label(total: int) -> str:
    total = max(0, int(total or 0))
    h = total // 60
    mi = total % 60
    return f"{h} ч {mi:02d} мин"


def _format_date_ru(value: str | int | float | datetime | None) -> str:
    if value is None:
        return ""
    try:
        if isinstance(value, datetime):
            d = value
        elif isinstance(value, (int, float)):
            d = datetime.fromtimestamp(
                float(value) / 1000 if float(value) > 10_000_000_000 else float(value)
            )
        else:
            s = str(value).strip()
            if not s:
                return ""
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
                d = datetime.strptime(s, "%Y-%m-%d")
            else:
                d = datetime.fromisoformat(s)
        return d.strftime("%d.%m.%Y")
    except Exception:
        return str(value)


def _hhmm(ms: int | float | None) -> str:
    if not ms:
        return ""
    try:
        dt = datetime.fromtimestamp(float(ms) / 1000)
        return dt.strftime("%H:%M")
    except Exception:
        return ""


def _money_int(v) -> int:
    try:
        return max(0, int(round(float(v or 0))))
    except Exception:
        return 0


def _money_label(v) -> str:
    return f"{_money_int(v):,} ₽".replace(",", " ")


def _payment_label(v) -> str:
    s = str(v or "").strip().lower()
    mapping = {
        "cash": "Наличные",
        "card": "Карта",
        "transfer": "Перевод",
    }
    return mapping.get(s, "Не указано")


def _station_type_label(v) -> str:
    s = str(v or "").strip().lower()
    mapping = {
        "ps": "PlayStation",
        "playstation": "PlayStation",
        "racing": "Симулятор гонок",
        "simulator": "Симулятор гонок",
        "switch": "Nintendo Switch",
        "nintendo": "Nintendo Switch",
    }
    return mapping.get(s, "PlayStation")


def _station_name(sid: int | None, station_type: str | None = None) -> str:
    sid = int(sid or 0)
    st = str(station_type or "").strip().lower()
    if sid == 5 or st in {"racing", "simulator"}:
        return "Симулятор гонок"
    if sid == 6 or st in {"switch", "nintendo"}:
        return "Nintendo Switch"
    if 1 <= sid <= 4:
        return f"PS{sid}"
    return f"Станция {sid}" if sid else ""


def _tariff_label_export(rec: dict) -> str:
    label = str(rec.get("tariffLabel") or "").strip()
    if label:
        # Remove service suffixes like "(-1 час)" from export view.
        label = re.sub(r"\s*\([^)]*\)\s*$", "", label).strip()
        return label

    tid = str(rec.get("tariffId") or "").strip()
    if not tid:
        return ""

    m = re.match(r"^t(\d+)$", tid, flags=re.IGNORECASE)
    if m:
        n = int(m.group(1))
        return f"{n} {_ru_plural(n, 'час', 'часа', 'часов')}"

    m = re.match(r"^custom\s*[:\-]\s*(\d+)$", tid, flags=re.IGNORECASE)
    if m:
        total = int(m.group(1))
        h = total // 60
        mi = total % 60
        parts = []
        if h:
            parts.append(f"{h} {_ru_plural(h, 'час', 'часа', 'часов')}")
        if mi or not parts:
            parts.append(f"{mi} {_ru_plural(mi, 'минута', 'минуты', 'минут')}")
        return " ".join(parts)

    return tid


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except Exception:
        return default


def _normalize_payment_method(value, fallback: str = "cash") -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in {"cash", "card", "transfer"} else fallback


def _normalize_station_type_key(value, fallback: str = "ps") -> str:
    raw = str(value or "").strip().lower()
    mapping = {
        "ps": "ps",
        "playstation": "ps",
        "simulator": "simulator",
        "racing": "simulator",
        "switch": "switch",
        "nintendo": "switch",
    }
    return mapping.get(raw, fallback)


def _parse_date_key(value: str | None, fallback: str | None = None) -> str:
    candidate = str(value or fallback or "").strip()
    try:
        return datetime.strptime(candidate, "%Y-%m-%d").strftime("%Y-%m-%d")
    except Exception as e:
        raise ValueError(f"invalid_date_key:{candidate}") from e
