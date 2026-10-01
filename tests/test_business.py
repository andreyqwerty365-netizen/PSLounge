"""Exercise commercial workflows against the real Flask API and isolated SQLite."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import sqlite3
from uuid import uuid4

import pytest

from pslounge import state, web
from pslounge.business.database import DB_NAME
from pslounge.constants import STATE_FILE


PASSWORD = "test-owner-password"
DAY = "2026-10-01"


def station_state():
    return {
        "lastModified": 1,
        "stations": [{"id": 1, "name": "PS 1", "status": "idle", "stationType": "ps"}],
        "sessions": {},
        "settings": None,
        "achievements": None,
    }


def completed_session(identifier="session-1", amount=125.25):
    return {
        "id": identifier,
        "stationId": 1,
        "stationName": "PS 1",
        "stationType": "ps",
        "startTime": 1_790_800_000_000,
        "endTime": 1_790_803_600_000,
        "totalAmount": amount,
        "paymentMethod": "cash",
        "sales": [
            {
                "id": "sale-1",
                "time": 1_790_800_000_000,
                "type": "start",
                "minutes": 60,
                "amount": amount,
                "paymentMethod": "cash",
            }
        ],
    }


class BusinessClient:
    def __init__(self, directory, client=None):
        self.directory = directory
        self.client = client or web.app.test_client()
        self.csrf = None
        self.user = None

    def status(self):
        result = self.client.get("/api/accounts/status")
        assert result.status_code == 200, result.get_json()
        value = result.get_json()
        self.csrf, self.user = value["csrf"], value["user"]
        return value

    def account(self, operation, data):
        if not self.csrf:
            self.status()
        response = self.client.post(
            f"/api/accounts/{operation}",
            json=data,
            headers={"X-PSLounge-CSRF": self.csrf},
        )
        if response.status_code == 200 and operation != "logout":
            self.csrf = response.get_json()["csrf"]
            self.user = response.get_json()["user"]
        return response

    def setup(self):
        response = self.account(
            "setup",
            {
                "login": "owner",
                "password": PASSWORD,
                "name": "Владелец",
                "role": "operator",
            },
        )
        assert response.status_code == 200, response.get_json()
        assert self.user["role"] == "owner"
        return self.user

    def command(self, operation, data, key=None, expected=200):
        response = self.client.post(
            f"/api/business/{operation}",
            json=data,
            headers={
                "X-PSLounge-CSRF": self.csrf or "",
                "X-Idempotency-Key": key or uuid4().hex,
            },
        )
        assert response.status_code == expected, response.get_json()
        return response.get_json()

    def business(self):
        response = self.client.get("/api/business")
        assert response.status_code == 200, response.get_json()
        return response.get_json()

    def snapshot(self):
        response = self.client.get("/api/backup")
        assert response.status_code == 200, response.get_json()
        return response.get_json()

    def save(self, value, expected=200, key=None):
        response = self.client.post(
            "/api/backup",
            json=value,
            headers={
                "X-PSLounge-CSRF": self.csrf or "",
                "X-Idempotency-Key": key or uuid4().hex,
            },
        )
        assert response.status_code == expected, response.get_json()
        return response.get_json()

    def seed_stations(self):
        value = station_state()
        value["baseRevision"] = self.snapshot()["revision"]
        return self.save(value)

    def restore(self, contents, expected=200):
        response = self.client.post(
            "/api/business-restore",
            data=contents,
            content_type="application/vnd.sqlite3",
            headers={"X-PSLounge-CSRF": self.csrf or ""},
        )
        assert response.status_code == expected, response.get_json()
        return response.get_json()


@pytest.fixture
def business(monkeypatch, tmp_path):
    monkeypatch.setattr(state, "_app_dir", lambda: tmp_path)
    monkeypatch.setattr(web, "_app_dir", lambda: tmp_path)
    # A license is isolated in tests only; the production verifier is unchanged.
    monkeypatch.setattr(web, "_require_license", lambda: None)
    return BusinessClient(tmp_path)


def test_owner_setup_csrf_and_no_password_disclosure(business):
    status = business.status()
    assert not status["configured"] and status["user"] is None
    missing = business.client.post(
        "/api/accounts/setup",
        json={"login": "owner", "password": PASSWORD, "name": "Owner"},
    )
    assert missing.status_code == 403
    assert missing.get_json()["error"] == "csrf_required"
    owner = business.setup()
    assert business.status()["configured"]
    assert "password" not in owner and "password_hash" not in owner
    assert (
        business.account(
            "setup", {"login": "another", "password": PASSWORD, "name": "Other"}
        ).status_code
        == 409
    )
    with sqlite3.connect(business.directory / DB_NAME) as conn:
        hashed = conn.execute("SELECT password_hash FROM users").fetchone()[0]
    assert hashed != PASSWORD and hashed.startswith("scrypt:")
    assert (
        business.client.get("/api/business")
        .headers.get("Set-Cookie", "")
        .find(PASSWORD)
        == -1
    )


def test_unlicensed_business_is_still_blocked(business, monkeypatch):
    monkeypatch.setattr(
        web,
        "_require_license",
        lambda: ({"ok": False, "error": "license_required"}, 403),
    )
    for route in ("/api/accounts/status", "/api/business", "/api/backup"):
        assert business.client.get(route).status_code == 403


def test_accounts_roles_csrf_last_owner_and_revoked_operator(business):
    owner = business.setup()
    created = business.command(
        "users/create",
        {
            "login": "operator",
            "name": "Кассир",
            "password": PASSWORD,
            "role": "operator",
        },
    )["user"]
    assert (
        business.command(
            "users/save", {"id": owner["id"], "active": False}, expected=409
        )["error"]
        == "last_owner"
    )
    assert (
        business.command(
            "users/save", {"id": owner["id"], "role": "operator"}, expected=409
        )["error"]
        == "last_owner"
    )
    missing = business.client.post(
        "/api/business/shifts/open",
        json={"opening": 0},
        headers={"X-Idempotency-Key": uuid4().hex},
    )
    assert missing.status_code == 403 and missing.get_json()["error"] == "csrf_required"
    anonymous = BusinessClient(business.directory)
    assert anonymous.client.get("/api/business").status_code == 401
    assert anonymous.client.get("/api/business-backup.sqlite3").status_code == 401
    operator = BusinessClient(business.directory)
    assert (
        operator.account(
            "login", {"login": "operator", "password": PASSWORD}
        ).status_code
        == 200
    )
    for route in ("products/save", "users/create", "refund"):
        assert operator.command(route, {}, expected=403)["error"] == "owner_required"
    assert operator.business()["users"] == [] and operator.business()["audit"] == []
    business.seed_stations()
    value = operator.snapshot()
    value.update(baseRevision=value["revision"], settings={"venue": "changed"})
    assert operator.save(value, expected=403)["error"] == "owner_required"
    business.command("users/save", {"id": created["id"], "active": False})
    assert operator.client.get("/api/business").status_code == 401


def test_login_throttle_persists_across_clients(business):
    business.setup()
    for _ in range(5):
        client = BusinessClient(business.directory)
        response = client.account(
            "login", {"login": "owner", "password": "incorrect-password"}
        )
        assert (
            response.status_code == 401
            and response.get_json()["error"] == "invalid_credentials"
        )
    another = BusinessClient(business.directory)
    locked = another.account("login", {"login": "owner", "password": PASSWORD})
    assert locked.status_code == 429 and locked.get_json()["error"] == "login_locked"
    with sqlite3.connect(business.directory / DB_NAME) as conn:
        assert (
            conn.execute(
                "SELECT attempts FROM login_attempts WHERE login='owner'"
            ).fetchone()[0]
            == 5
        )


def test_legacy_migration_keeps_original_and_money_and_old_history(business):
    value = station_state()
    legacy = completed_session()
    legacy.pop("id")
    legacy.pop("sales")
    value["sessions"] = {"2020-01-01": [legacy]}
    original = json.dumps(value, ensure_ascii=False).encode()
    (business.directory / STATE_FILE).write_bytes(original)
    business.setup()
    migrated = business.snapshot()
    assert migrated["revision"] == 1
    assert migrated["sessions"]["2020-01-01"][0]["sales"][0]["amount"] == 125.25
    payments = business.business()["payments"]
    assert len(payments) == 1 and payments[0]["amount_cents"] == 12525
    assert payments[0]["shift_id"] is None and payments[0]["actor_id"] is None
    assert (business.directory / STATE_FILE).read_bytes() == original
    business.command("shifts/open", {"opening": "10.01"})
    assert business.business()["activeShift"]["expected_cents"] == 1001
    migrated["baseRevision"] = migrated["revision"]
    migrated["sessions"] = {}
    business.save(migrated)
    assert len(business.snapshot()["sessions"]["2020-01-01"]) == 1
    assert len(business.business()["payments"]) == 1


@pytest.mark.parametrize(
    "amount", [True, -1, "0.001", "NaN", "Infinity", "10000000.01"]
)
def test_invalid_money_is_rejected_without_mutation(business, amount):
    business.setup()
    assert (
        business.command("shifts/open", {"opening": amount}, expected=400)["error"]
        == "invalid_amount"
    )
    assert business.business()["activeShift"] is None


def test_product_sale_retry_is_atomic_and_price_stock_are_checked(business):
    business.setup()
    product = business.command(
        "products/save", {"name": "Напиток", "price": "12.35", "stock": 3}
    )["productId"]
    sale = {
        "productId": product,
        "quantity": 2,
        "method": "cash",
        "expectedPriceCents": 1235,
    }
    assert (
        business.command("products/sell", sale, expected=409)["error"]
        == "shift_required"
    )
    assert business.business()["products"][0]["stock"] == 3
    business.command("shifts/open", {"opening": 0})
    key = uuid4().hex
    first = business.command("products/sell", sale, key=key)
    assert business.command("products/sell", sale, key=key) == first
    assert (
        business.command(
            "products/sell", {**sale, "quantity": 1}, key=key, expected=409
        )["error"]
        == "idempotency_conflict"
    )
    assert (
        business.command("products/sell", sale, expected=409)["error"]
        == "insufficient_stock"
    )
    assert (
        business.command(
            "products/sell",
            {**sale, "quantity": 1, "expectedPriceCents": 1200},
            expected=409,
        )["error"]
        == "price_changed"
    )
    result = business.business()
    assert result["products"][0]["stock"] == 1
    assert (
        len(result["payments"]) == 1 and result["payments"][0]["amount_cents"] == 2470
    )
    assert result["activeShift"]["revenue_cents"] == 2470
    with sqlite3.connect(business.directory / DB_NAME) as conn:
        assert (
            conn.execute("SELECT sum(quantity) FROM stock_movements").fetchone()[0] == 1
        )


def test_shift_refund_cash_reconciliation_and_close_retains_history(business):
    business.setup()
    shift = business.command("shifts/open", {"opening": "100.01"})["shiftId"]
    assert (
        business.command("shifts/open", {"opening": 0}, expected=409)["error"]
        == "shift_already_open"
    )
    product = business.command(
        "products/save", {"name": "Snack", "price": "12.35", "stock": 3}
    )["productId"]
    receipt = business.command(
        "products/sell", {"productId": product, "quantity": 2, "method": "cash"}
    )["paymentId"]
    business.command(
        "products/sell", {"productId": product, "quantity": 1, "method": "card"}
    )
    business.command("cash", {"kind": "cash_in", "amount": "10.01", "reason": "Размен"})
    assert (
        business.command(
            "cash",
            {"kind": "cash_out", "amount": 999, "reason": "Инкассация"},
            expected=409,
        )["error"]
        == "insufficient_cash"
    )
    business.command(
        "cash", {"kind": "cash_out", "amount": "5.02", "reason": "Инкассация"}
    )
    refund_key = uuid4().hex
    refund = {
        "paymentId": receipt,
        "amount": "24.70",
        "reason": "Товар возвращён",
        "restock": True,
    }
    first = business.command("refund", refund, key=refund_key)
    assert business.command("refund", refund, key=refund_key) == first
    assert (
        business.command("refund", refund, expected=409)["error"]
        == "refund_exceeds_payment"
    )
    result = business.business()
    assert result["products"][0]["stock"] == 2
    assert result["activeShift"]["expected_cents"] == 10500
    assert result["activeShift"]["totals"] == {"cash": 499, "card": 1235, "transfer": 0}
    assert result["activeShift"]["revenue_cents"] == 1235
    assert (
        business.command("shifts/close", {"actual": 104}, expected=400)["error"]
        == "difference_reason_required"
    )
    assert business.business()["activeShift"] is not None
    closed = business.command(
        "shifts/close", {"actual": 104, "note": "Недостача 1 рубль"}
    )
    assert closed["expectedCents"] == 10500 and closed["differenceCents"] == -100
    result = business.business()
    assert result["activeShift"] is None
    assert (
        result["shifts"][0]["id"] == shift
        and result["shifts"][0]["difference_cents"] == -100
    )
    assert len(result["payments"]) == 5


def test_operator_cannot_use_other_operators_open_shift(business):
    business.setup()
    business.command(
        "users/create", {"login": "operator", "name": "Operator", "password": PASSWORD}
    )
    business.command("shifts/open", {"opening": 50})
    operator = BusinessClient(business.directory)
    operator.account("login", {"login": "operator", "password": PASSWORD})
    assert (
        operator.command(
            "cash", {"kind": "cash_in", "amount": 1, "reason": "Размен"}, expected=403
        )["error"]
        == "another_operator_shift"
    )
    assert (
        operator.command("shifts/close", {"actual": 50}, expected=403)["error"]
        == "another_operator_shift"
    )
    assert business.business()["activeShift"]["expected_cents"] == 5000


def test_snapshot_revision_history_merge_and_sale_immutability(business):
    business.setup()
    business.seed_stations()
    business.command("shifts/open", {"opening": 0})
    value = business.snapshot()
    value["baseRevision"] = value["revision"]
    value["sessions"] = {DAY: [completed_session()]}
    key = uuid4().hex
    saved = business.save(value, key=key)
    assert business.save(value, key=key) == saved
    assert business.save(value, expected=409)["error"] == "revision_conflict"
    current = business.snapshot()
    assert current["revision"] == saved["revision"]
    changed = deepcopy(current)
    changed["baseRevision"] = current["revision"]
    changed["sessions"][DAY][0]["sales"][0]["amount"] = 1
    changed["sessions"][DAY][0]["totalAmount"] = 1
    assert business.save(changed, expected=409)["error"] == "payment_immutable"
    removed = deepcopy(current)
    removed["baseRevision"] = current["revision"]
    removed["sessions"][DAY][0]["sales"] = []
    removed["sessions"][DAY][0]["totalAmount"] = 0
    assert business.save(removed, expected=409)["error"] == "payment_immutable"
    current.update(baseRevision=current["revision"], sessions={})
    business.save(current)
    assert len(business.snapshot()["sessions"][DAY]) == 1
    assert len(business.business()["payments"]) == 1
    assert business.business()["activeShift"]["expected_cents"] == 12525
    invalid = business.snapshot()
    invalid["baseRevision"] = invalid["revision"]
    invalid["stations"][0]["startTime"] = float("nan")
    assert business.save(invalid, expected=400)["error"] == "invalid_state_shape"


def test_parallel_clients_cannot_overwrite_same_revision(business):
    business.setup()
    business.seed_stations()
    value = business.snapshot()
    value["baseRevision"] = value["revision"]
    cookie = business.client.get_cookie(web.app.config["SESSION_COOKIE_NAME"])

    def write(index):
        client = web.app.test_client()
        client.set_cookie(cookie.key, cookie.value)
        return client.post(
            "/api/backup",
            json={**value, "lastModified": index + 1},
            headers={
                "X-PSLounge-CSRF": business.csrf,
                "X-Idempotency-Key": uuid4().hex,
            },
        )

    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(write, range(6)))
    assert sorted(response.status_code for response in responses) == [
        200,
        409,
        409,
        409,
        409,
        409,
    ]
    assert business.snapshot()["revision"] == value["revision"] + 1
    assert all(
        response.status_code == 200
        or response.get_json()["error"] == "revision_conflict"
        for response in responses
    )


def test_pass_minutes_redeem_retry_conflict_and_unused_refund(business):
    business.setup()
    business.seed_stations()
    business.command("shifts/open", {"opening": 0})
    customer = business.command(
        "customers/create", {"name": "Клиент", "contact": "+7 000 000 00 00"}
    )["customerId"]
    receipt = business.command(
        "passes/sell",
        {
            "customerId": customer,
            "minutes": 120,
            "amount": "300.01",
            "method": "transfer",
        },
    )["paymentId"]
    revision = business.snapshot()["revision"]
    operation = {
        "customerId": customer,
        "minutes": 30,
        "stationId": 1,
        "baseRevision": revision,
        "day": DAY,
    }
    assert (
        business.command(
            "passes/redeem", {**operation, "baseRevision": revision - 1}, expected=409
        )["error"]
        == "revision_conflict"
    )
    assert business.business()["customers"][0]["minutes"] == 120
    key = uuid4().hex
    result = business.command("passes/redeem", operation, key=key)
    assert business.command("passes/redeem", operation, key=key) == result
    assert result["revision"] == revision + 1
    assert result["state"]["stations"][0]["status"] == "running"
    record = result["state"]["sessions"][DAY][0]
    assert record["totalAmount"] == 0 and record["sales"][0]["minutes"] == 30
    assert result["state"]["stations"][0]["endTime"] - record["startTime"] == 30 * 60000
    assert business.business()["customers"][0]["minutes"] == 90
    assert (
        business.command(
            "passes/redeem",
            {**operation, "minutes": 91, "baseRevision": result["revision"]},
            expected=409,
        )["error"]
        == "insufficient_minutes"
    )
    assert (
        business.command(
            "refund",
            {"paymentId": receipt, "amount": "300.01", "reason": "Возврат"},
            expected=409,
        )["error"]
        == "pass_refund_requires_unused_balance"
    )
    other = business.command("customers/create", {"name": "Другой клиент"})[
        "customerId"
    ]
    other_receipt = business.command(
        "passes/sell",
        {"customerId": other, "minutes": 60, "amount": 100, "method": "card"},
    )["paymentId"]
    business.command(
        "refund",
        {"paymentId": other_receipt, "amount": 100, "reason": "Не использован"},
    )
    balances = {
        entry["id"]: entry["minutes"] for entry in business.business()["customers"]
    }
    assert balances == {customer: 90, other: 0}
    assert business.business()["activeShift"]["revenue_cents"] == 30001


@pytest.mark.parametrize(
    "table,column",
    [
        ("payments", "amount_cents"),
        ("audit", "created_at"),
        ("stock_movements", "quantity"),
        ("pass_movements", "minutes"),
    ],
)
def test_financial_audit_and_inventory_are_database_append_only(
    business, table, column
):
    business.setup()
    business.command("shifts/open", {"opening": 0})
    product = business.command(
        "products/save", {"name": "Product", "price": 10, "stock": 1}
    )["productId"]
    business.command(
        "products/sell", {"productId": product, "quantity": 1, "method": "cash"}
    )
    customer = business.command("customers/create", {"name": "Customer"})["customerId"]
    business.command(
        "passes/sell",
        {"customerId": customer, "minutes": 60, "amount": 10, "method": "card"},
    )
    with sqlite3.connect(business.directory / DB_NAME) as conn:
        count = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        assert count > 0
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(f"UPDATE {table} SET {column}=0")
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            conn.execute(f"DELETE FROM {table}")
        assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == count


def test_backup_restore_rejects_damage_schema_and_keeps_previous_database(
    business, tmp_path
):
    business.setup()
    business.seed_stations()
    business.command("shifts/open", {"opening": "50.01"})
    backup = business.client.get("/api/business-backup.sqlite3")
    assert backup.status_code == 200 and backup.data.startswith(b"SQLite format 3\x00")
    business.command("products/save", {"name": "After backup", "price": 10, "stock": 3})
    assert (
        business.restore(b"not-a-database", expected=400)["error"] == "invalid_backup"
    )
    assert (
        business.restore(backup.data[:100], expected=400)["error"] == "invalid_backup"
    )
    altered = tmp_path / "altered.sqlite3"
    altered.write_bytes(backup.data)
    with sqlite3.connect(altered) as conn:
        conn.execute("DROP TRIGGER payments_no_delete")
    assert (
        business.restore(altered.read_bytes(), expected=400)["error"]
        == "invalid_backup_schema"
    )
    assert business.business()["products"][0]["name"] == "After backup"
    assert not list(tmp_path.glob("*.restore"))
    assert business.restore(backup.data)["reauthenticate"] is True
    assert business.client.get("/api/business").status_code == 401
    business.status()
    assert (
        business.account("login", {"login": "owner", "password": PASSWORD}).status_code
        == 200
    )
    restored = business.business()
    assert restored["products"] == []
    assert restored["activeShift"]["expected_cents"] == 5001
    assert any(row["action"] == "database_restored" for row in restored["audit"])
    archives = list((tmp_path / "database_backups").glob("before-restore-*.sqlite3"))
    assert len(archives) == 1
    with sqlite3.connect(archives[0]) as conn:
        assert conn.execute("SELECT name FROM products").fetchone()[0] == "After backup"
    assert not list(tmp_path.glob("*.restore"))


def test_invalid_json_and_missing_command_key_do_not_create_shift(business):
    business.setup()
    missing = business.client.post(
        "/api/business/shifts/open",
        json={"opening": 0},
        headers={"X-PSLounge-CSRF": business.csrf},
    )
    assert missing.status_code == 400
    assert missing.get_json()["error"] == "idempotency_key_required"
    bad = business.client.post(
        "/api/business/shifts/open",
        json=["not-an-object"],
        headers={"X-PSLounge-CSRF": business.csrf, "X-Idempotency-Key": uuid4().hex},
    )
    assert bad.status_code == 400 and bad.get_json()["error"] == "bad_json"
    assert business.business()["activeShift"] is None


def test_snapshot_total_mismatch_and_duplicate_sale_are_atomic(business):
    business.setup()
    business.seed_stations()
    business.command("shifts/open", {"opening": 0})
    original = business.snapshot()
    value = deepcopy(original)
    value["baseRevision"] = original["revision"]
    record = completed_session()
    record["totalAmount"] = 200
    value["sessions"] = {DAY: [record]}
    assert business.save(value, expected=409)["error"] == "session_total_mismatch"
    record["totalAmount"] = 250.50
    record["sales"].append(deepcopy(record["sales"][0]))
    assert business.save(value, expected=409)["error"] == "duplicate_sale"
    assert business.snapshot()["revision"] == original["revision"]
    assert business.business()["payments"] == []
    assert business.business()["activeShift"]["expected_cents"] == 0


def test_partial_product_refund_and_insufficient_cash_preserve_stock(business):
    business.setup()
    business.command("shifts/open", {"opening": 0})
    product = business.command(
        "products/save", {"name": "Product", "price": 100, "stock": 2}
    )["productId"]
    payment = business.command(
        "products/sell", {"productId": product, "quantity": 2, "method": "cash"}
    )["paymentId"]
    partial = {"paymentId": payment, "amount": 50, "reason": "Частичная компенсация"}
    assert (
        business.command("refund", {**partial, "restock": True}, expected=400)["error"]
        == "restock_requires_full_refund"
    )
    business.command(
        "cash", {"kind": "cash_out", "amount": 200, "reason": "Инкассация"}
    )
    assert (
        business.command("refund", partial, expected=409)["error"]
        == "insufficient_cash"
    )
    assert business.business()["products"][0]["stock"] == 0
    business.command(
        "cash", {"kind": "cash_in", "amount": 50, "reason": "Для возврата"}
    )
    business.command("refund", partial)
    result = business.business()
    assert result["products"][0]["stock"] == 0
    assert result["activeShift"]["expected_cents"] == 0
    assert result["activeShift"]["revenue_cents"] == 15000
    original = next(row for row in result["payments"] if row["id"] == payment)
    assert original["amount_cents"] == 20000 and original["refundable_cents"] == 15000


def test_service_sales_do_not_require_stock(business):
    business.setup()
    business.seed_stations()
    business.command("shifts/open", {"opening": 0})
    product = business.command(
        "products/save",
        {"name": "Service", "price": "15.25", "stock": 0, "trackStock": False},
    )
    business.command(
        "products/sell",
        {"productId": product["productId"], "quantity": 2, "method": "card"},
    )
    result = business.business()
    assert result["products"][0]["stock"] == 0
    assert result["activeShift"]["revenue_cents"] == 3050
    with sqlite3.connect(business.directory / DB_NAME) as conn:
        assert conn.execute("SELECT count(*) FROM stock_movements").fetchone()[0] == 0


def test_daily_recovery_backup_is_consistent_and_created_once(business, tmp_path):
    business.setup()
    business.seed_stations()
    files = list((tmp_path / "database_backups").glob("daily-*.sqlite3"))
    assert len(files) == 1
    original = files[0].read_bytes()
    business.command("shifts/open", {"opening": "1.01"})
    assert files[0].read_bytes() == original
    with sqlite3.connect(files[0]) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("SELECT count(*) FROM users").fetchone()[0] == 1


def test_operator_cannot_discount_a_game_sale_through_snapshot(business):
    business.setup()
    business.seed_stations()
    snapshot = business.snapshot()
    snapshot.update(
        baseRevision=snapshot["revision"],
        settings={
            "stationDefinitions": [{"id": 1, "name": "PS 1", "type": "ps"}],
            "tariffGroups": {
                "ps": [{"id": "one-hour", "minutes": 60, "price": 125.25}]
            },
            "customRates": {"ps": 125.25},
        },
    )
    business.save(snapshot)
    business.command(
        "users/create", {"login": "operator", "name": "Operator", "password": PASSWORD}
    )
    operator = BusinessClient(business.directory)
    operator.account("login", {"login": "operator", "password": PASSWORD})
    operator.command("shifts/open", {"opening": 0})
    snapshot = operator.snapshot()
    record = completed_session(amount=1)
    record["sales"][0].update(type="start_tariff", tariffId="one-hour")
    snapshot.update(baseRevision=snapshot["revision"], sessions={DAY: [record]})
    assert operator.save(snapshot, expected=409)["error"] == "tariff_price_changed"
    assert operator.business()["payments"] == []
    record["sales"][0]["amount"] = record["totalAmount"] = 125.25
    operator.save(snapshot)
    assert operator.business()["payments"][0]["amount_cents"] == 12525


def test_browser_cannot_create_pass_minutes_without_debit(business):
    business.setup()
    business.seed_stations()
    business.command("shifts/open", {"opening": 0})
    snapshot = business.snapshot()
    record = completed_session(amount=0)
    record["sales"][0].update(type="pass_minutes", customerId="unknown")
    snapshot.update(baseRevision=snapshot["revision"], sessions={DAY: [record]})
    assert business.save(snapshot, expected=403)["error"] == "pass_command_required"
    assert business.business()["payments"] == []


def test_migration_keeps_original_conflicting_reported_total(business):
    snapshot = station_state()
    record = completed_session()
    record["totalAmount"] = 999
    snapshot["sessions"] = {DAY: [record]}
    original = json.dumps(snapshot).encode()
    (business.directory / STATE_FILE).write_bytes(original)
    business.setup()
    migrated = business.snapshot()["sessions"][DAY][0]
    assert migrated["legacyReportedTotal"] == 999
    assert migrated["totalAmount"] == 125.25
    assert (
        business.business()["payments"][0]["created_at"] == record["sales"][0]["time"]
    )
    assert (business.directory / STATE_FILE).read_bytes() == original
