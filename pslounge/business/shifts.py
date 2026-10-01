from __future__ import annotations

import json

from .database import (
    BusinessError,
    active_shift,
    audit,
    insert_payment,
    money,
    now,
    text,
    uid,
)


def summary(conn, row):
    result = dict(row)
    groups = conn.execute(
        """SELECT method,kind,sum(amount_cents) AS amount
       FROM payments WHERE shift_id=? GROUP BY method,kind""",
        (row["id"],),
    ).fetchall()
    totals = {"cash": 0, "card": 0, "transfer": 0}
    revenue = 0
    for group in groups:
        totals[group["method"]] += group["amount"]
        if group["kind"] not in ("cash_in", "cash_out"):
            revenue += group["amount"]
    expected = row["opening_cents"] + totals["cash"]
    result.update(
        totals=totals,
        revenue_cents=revenue,
        expected_cents=expected,
        difference_cents=None
        if row["actual_cents"] is None
        else row["actual_cents"] - expected,
    )
    result["operator"] = conn.execute(
        "SELECT name FROM users WHERE id=?", (row["opened_by"],)
    ).fetchone()[0]
    return result


def open_shift(conn, user, data):
    if conn.execute("SELECT 1 FROM shifts WHERE closed_at IS NULL").fetchone():
        raise BusinessError("shift_already_open", 409)
    identifier, opening = uid(), money(data.get("opening", 0))
    conn.execute(
        "INSERT INTO shifts(id,opened_at,opened_by,opening_cents) VALUES(?,?,?,?)",
        (identifier, now(), user["id"], opening),
    )
    audit(conn, user, "shift_opened", {"shiftId": identifier, "openingCents": opening})
    return {"ok": True, "shiftId": identifier}


def close_shift(conn, user, data):
    row = active_shift(conn, user)
    actual = money(data.get("actual"))
    expected = summary(conn, row)["expected_cents"]
    note = text(data.get("note", ""), required=False, maximum=500)
    if actual != expected and not note:
        raise BusinessError("difference_reason_required")
    conn.execute(
        "UPDATE shifts SET closed_at=?,closed_by=?,actual_cents=?,expected_cents=?,note=? WHERE id=?",
        (now(), user["id"], actual, expected, note, row["id"]),
    )
    audit(
        conn,
        user,
        "shift_closed",
        {
            "shiftId": row["id"],
            "actualCents": actual,
            "expectedCents": expected,
            "note": note,
        },
    )
    return {
        "ok": True,
        "shiftId": row["id"],
        "expectedCents": expected,
        "differenceCents": actual - expected,
    }


def cash_movement(conn, user, data):
    kind = data.get("kind")
    if kind not in ("cash_in", "cash_out"):
        raise BusinessError("invalid_cash_movement")
    cents = money(data.get("amount"))
    if cents <= 0:
        raise BusinessError("invalid_amount")
    reason = text(data.get("reason"), maximum=500)
    if kind == "cash_out":
        row = active_shift(conn, user)
        if summary(conn, row)["expected_cents"] < cents:
            raise BusinessError("insufficient_cash", 409)
        cents = -cents
    payment = insert_payment(
        conn, user, kind, cents, "cash", details={"reason": reason}
    )
    audit(conn, user, kind, {"paymentId": payment, "reason": reason})
    return {"ok": True, "paymentId": payment}


def refund(conn, user, data):
    if user["role"] != "owner":
        raise BusinessError("owner_required", 403)
    original = conn.execute(
        "SELECT * FROM payments WHERE id=?", (data.get("paymentId"),)
    ).fetchone()
    if not original or original["kind"] not in ("game", "product", "pass"):
        raise BusinessError("payment_not_found", 404)
    cents = money(data.get("amount"))
    reason = text(data.get("reason"), maximum=500)
    refunded = conn.execute(
        "SELECT coalesce(sum(-amount_cents),0) FROM payments WHERE parent_id=?",
        (original["id"],),
    ).fetchone()[0]
    if cents <= 0 or refunded + cents > original["amount_cents"]:
        raise BusinessError("refund_exceeds_payment", 409)
    if original["kind"] == "pass":
        details = json.loads(original["details"])
        balance = conn.execute(
            "SELECT coalesce(sum(minutes),0) FROM pass_movements WHERE customer_id=?",
            (original["customer_id"],),
        ).fetchone()[0]
        if (
            refunded
            or cents != original["amount_cents"]
            or balance < details["minutes"]
        ):
            raise BusinessError("pass_refund_requires_unused_balance", 409)
    restock = data.get("restock", False)
    if not isinstance(restock, bool):
        raise BusinessError("invalid_restock")
    if restock and original["product_id"]:
        product = conn.execute(
            "SELECT * FROM products WHERE id=?", (original["product_id"],)
        ).fetchone()
        if not product["track_stock"]:
            restock = False
    if restock and (
        original["kind"] != "product" or refunded or cents != original["amount_cents"]
    ):
        raise BusinessError("restock_requires_full_refund")
    if (
        original["method"] == "cash"
        and summary(conn, active_shift(conn, user))["expected_cents"] < cents
    ):
        raise BusinessError("insufficient_cash", 409)
    payment = insert_payment(
        conn,
        user,
        "refund",
        -cents,
        original["method"],
        parent=original["id"],
        customer=original["customer_id"],
        product=original["product_id"],
        details={"reason": reason},
    )
    if restock:
        conn.execute(
            "UPDATE products SET stock=stock+? WHERE id=?",
            (original["quantity"], original["product_id"]),
        )
        conn.execute(
            "INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?)",
            (
                uid(),
                original["product_id"],
                original["quantity"],
                user["id"],
                now(),
                reason,
                payment,
            ),
        )
    if original["kind"] == "pass":
        conn.execute(
            "INSERT INTO pass_movements VALUES(?,?,?,?,?,?,?)",
            (
                uid(),
                original["customer_id"],
                -details["minutes"],
                user["id"],
                now(),
                reason,
                payment,
            ),
        )
    audit(
        conn,
        user,
        "refund",
        {"paymentId": payment, "originalId": original["id"], "reason": reason},
    )
    return {"ok": True, "paymentId": payment}
