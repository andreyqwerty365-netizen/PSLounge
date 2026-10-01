from __future__ import annotations

from datetime import datetime

from .database import (
    BusinessError,
    audit,
    insert_payment,
    integer,
    money,
    now,
    text,
    uid,
)
from .snapshots import ingest, load, persist


def product_save(conn, user, data):
    name, price = text(data.get("name")), money(data.get("price"))
    stock = integer(data.get("stock", 0), minimum=0)
    identifier = data.get("id") or uid()
    previous = conn.execute(
        "SELECT * FROM products WHERE id=?", (identifier,)
    ).fetchone()
    active = data.get("active", True)
    track_stock = data.get(
        "trackStock", bool(previous["track_stock"]) if previous else True
    )
    if not isinstance(track_stock, bool):
        raise BusinessError("invalid_track_stock")
    if not track_stock:
        stock = 0
    if previous and previous["track_stock"] != int(track_stock):
        raise BusinessError("product_type_immutable", 409)
    if not isinstance(active, bool):
        raise BusinessError("invalid_active")
    if data.get("id") and previous is None:
        raise BusinessError("product_not_found", 404)
    reason = text(
        data.get("reason", "Первоначальный остаток")
        if not previous
        else data.get("reason", ""),
        required=previous is None or previous["stock"] != stock,
        maximum=500,
    )
    if previous:
        conn.execute(
            "UPDATE products SET name=?,price_cents=?,stock=?,active=? WHERE id=?",
            (name, price, stock, int(active), identifier),
        )
    else:
        conn.execute(
            "INSERT INTO products(id,name,price_cents,stock,track_stock,active) VALUES(?,?,?,?,?,?)",
            (identifier, name, price, stock, int(track_stock), int(active)),
        )
    delta = stock - (previous["stock"] if previous else 0)
    if delta:
        conn.execute(
            "INSERT INTO stock_movements VALUES(?,?,?,?,?,?,NULL)",
            (uid(), identifier, delta, user["id"], now(), reason),
        )
    audit(
        conn,
        user,
        "product_saved",
        {"productId": identifier, "name": name, "stock": stock},
    )
    return {"ok": True, "productId": identifier}


def sell(conn, user, data):
    product = conn.execute(
        "SELECT * FROM products WHERE id=? AND active=1", (data.get("productId"),)
    ).fetchone()
    if product is None:
        raise BusinessError("product_not_found", 404)
    quantity = integer(data.get("quantity", 1))
    if product["track_stock"] and product["stock"] < quantity:
        raise BusinessError("insufficient_stock", 409)
    if data.get("expectedPriceCents", product["price_cents"]) != product["price_cents"]:
        raise BusinessError("price_changed", 409)
    if product["track_stock"]:
        conn.execute(
            "UPDATE products SET stock=stock-? WHERE id=?", (quantity, product["id"])
        )
    payment = insert_payment(
        conn,
        user,
        "product",
        product["price_cents"] * quantity,
        data.get("method"),
        product=product["id"],
        quantity=quantity,
        details={"name": product["name"], "unitPriceCents": product["price_cents"]},
    )
    if product["track_stock"]:
        conn.execute(
            "INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?)",
            (uid(), product["id"], -quantity, user["id"], now(), "Продажа", payment),
        )
    audit(conn, user, "product_sold", {"paymentId": payment, "quantity": quantity})
    return {"ok": True, "paymentId": payment}


def customer_create(conn, user, data):
    identifier = uid()
    name = text(data.get("name"), maximum=80)
    contact = text(data.get("contact", ""), required=False, maximum=100)
    conn.execute("INSERT INTO customers VALUES(?,?,?)", (identifier, name, contact))
    audit(conn, user, "customer_created", {"customerId": identifier})
    return {"ok": True, "customerId": identifier}


def pass_sell(conn, user, data):
    customer = conn.execute(
        "SELECT * FROM customers WHERE id=?", (data.get("customerId"),)
    ).fetchone()
    if customer is None:
        raise BusinessError("customer_not_found", 404)
    minutes = integer(data.get("minutes"))
    cents = money(data.get("amount"))
    if cents <= 0:
        raise BusinessError("invalid_amount")
    payment = insert_payment(
        conn,
        user,
        "pass",
        cents,
        data.get("method"),
        customer=customer["id"],
        details={"minutes": minutes, "name": customer["name"]},
    )
    conn.execute(
        "INSERT INTO pass_movements VALUES(?,?,?,?,?,?,?)",
        (
            uid(),
            customer["id"],
            minutes,
            user["id"],
            now(),
            "Покупка абонемента",
            payment,
        ),
    )
    audit(conn, user, "pass_sold", {"paymentId": payment, "minutes": minutes})
    return {"ok": True, "paymentId": payment}


def pass_redeem(conn, user, data):
    customer = conn.execute(
        "SELECT * FROM customers WHERE id=?", (data.get("customerId"),)
    ).fetchone()
    if customer is None:
        raise BusinessError("customer_not_found", 404)
    minutes = integer(data.get("minutes"))
    balance = conn.execute(
        "SELECT coalesce(sum(minutes),0) FROM pass_movements WHERE customer_id=?",
        (customer["id"],),
    ).fetchone()[0]
    if balance < minutes:
        raise BusinessError("insufficient_minutes", 409)
    snapshot = load(conn)
    if data.get("baseRevision") != snapshot["revision"]:
        raise BusinessError(
            "revision_conflict", 409, currentRevision=snapshot["revision"]
        )
    station = next(
        (
            item
            for item in snapshot.get("stations") or []
            if item["id"] == data.get("stationId")
        ),
        None,
    )
    if station is None:
        raise BusinessError("station_not_found", 404)
    timestamp = now()
    if station["status"] == "idle":
        key = data.get("day") or datetime.now().strftime("%Y-%m-%d")
        try:
            datetime.strptime(key, "%Y-%m-%d")
        except (ValueError, TypeError):
            raise BusinessError("invalid_date") from None
        record = {
            "id": uid(),
            "stationId": station["id"],
            "stationName": station.get("name"),
            "stationType": station.get("stationType") or "ps",
            "startTime": timestamp,
            "endTime": None,
            "tariffId": "pass",
            "tariffLabel": "Абонемент",
            "extraMinutes": 0,
            "mode": "started",
            "totalAmount": 0,
            "paymentMethod": "cash",
            "sales": [],
        }
        snapshot.setdefault("sessions", {}).setdefault(key, []).append(record)
        station.update(
            startTime=timestamp,
            activeSessionId=record["id"],
            tariffId="pass",
            endTime=timestamp,
            lastClosedSnapshot=None,
        )
    else:
        record = next(
            (
                rec
                for records in (snapshot.get("sessions") or {}).values()
                for rec in records
                if rec.get("id") == station.get("activeSessionId")
            ),
            None,
        )
        if record is None or record.get("endTime") is not None:
            raise BusinessError("session_not_found", 409)
    record.setdefault("sales", []).append(
        {
            "id": uid(),
            "time": timestamp,
            "type": "pass_minutes",
            "label": "Абонемент",
            "minutes": minutes,
            "amount": 0,
            "paymentMethod": "cash",
            "customerId": customer["id"],
        }
    )
    station["endTime"] = (
        max(station.get("endTime") or timestamp, timestamp) + minutes * 60_000
    )
    station["status"] = "running"
    conn.execute(
        "INSERT INTO pass_movements VALUES(?,?,?,?,?,?,NULL)",
        (
            uid(),
            customer["id"],
            -minutes,
            user["id"],
            timestamp,
            f"Станция {station['id']}",
        ),
    )
    snapshot["lastModified"] = max(
        timestamp, int(snapshot.get("lastModified") or 0) + 1
    )
    ingest(conn, snapshot, user, trusted_pass=True)
    audit(
        conn,
        user,
        "pass_redeemed",
        {"customerId": customer["id"], "stationId": station["id"], "minutes": minutes},
    )
    result = persist(conn, snapshot, user)
    result["state"] = load(conn)
    return result
