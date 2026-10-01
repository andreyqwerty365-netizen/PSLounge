from __future__ import annotations

from contextlib import closing, contextmanager
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import uuid

from .schema import SCHEMA, VERSION

LOCK = threading.RLock()
DB_NAME = "pslounge.sqlite3"


class BusinessError(Exception):
    def __init__(self, code, status=400, **extra):
        self.code, self.status, self.extra = code, status, extra
        super().__init__(code)


def now():
    return int(time.time() * 1000)


def uid():
    return uuid.uuid4().hex


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def money(value, *, signed=False):
    if isinstance(value, bool):
        raise BusinessError("invalid_amount")
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount != amount.quantize(Decimal(".01")):
            raise BusinessError("invalid_amount")
        cents = int(amount * 100)
        if abs(cents) > 1_000_000_000 or (not signed and cents < 0):
            raise BusinessError("invalid_amount")
        return cents
    except (InvalidOperation, TypeError, ValueError):
        raise BusinessError("invalid_amount") from None


def integer(value, minimum=1, maximum=1_000_000):
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise BusinessError("invalid_quantity")
    return value


def text(value, *, required=True, maximum=160):
    if not isinstance(value, str) or len(value.strip()) > maximum:
        raise BusinessError("invalid_text")
    value = value.strip()
    if required and not value:
        raise BusinessError("text_required")
    return value


def public_user(row):
    return {key: row[key] for key in ("id", "login", "name", "role", "active")}


def audit(conn, user, action, details):
    conn.execute(
        "INSERT INTO audit(actor_id,created_at,action,details) VALUES(?,?,?,?)",
        (user["id"] if user else None, now(), action, encode(details)),
    )


def active_shift(conn, user=None):
    row = conn.execute("SELECT * FROM shifts WHERE closed_at IS NULL").fetchone()
    if row is None:
        raise BusinessError("shift_required", 409)
    if user and user["role"] != "owner" and row["opened_by"] != user["id"]:
        raise BusinessError("another_operator_shift", 403)
    return row


def insert_payment(
    conn,
    user,
    kind,
    cents,
    method,
    *,
    source=None,
    parent=None,
    product=None,
    customer=None,
    quantity=0,
    details=None,
    imported=False,
):
    if method not in ("cash", "card", "transfer"):
        raise BusinessError("invalid_payment_method")
    shift = None if imported else active_shift(conn, user)
    identifier = uid()
    conn.execute(
        """INSERT INTO payments(id,source_key,shift_id,actor_id,created_at,kind,
      amount_cents,method,parent_id,product_id,customer_id,quantity,details)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            identifier,
            source or uid(),
            shift["id"] if shift else None,
            user["id"] if user else None,
            (details or {}).get("sale", {}).get("time", now()) if imported else now(),
            kind,
            cents,
            method,
            parent,
            product,
            customer,
            quantity,
            encode(details or {}),
        ),
    )
    return identifier


class Database:
    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / DB_NAME
        with LOCK:
            with closing(self.connection()) as conn:
                version = conn.execute("PRAGMA user_version").fetchone()[0]
                if version > VERSION:
                    raise BusinessError("newer_database_version", 409)
                conn.executescript(SCHEMA)
                if "track_stock" not in {
                    row[1] for row in conn.execute("PRAGMA table_info(products)")
                }:
                    conn.execute(
                        "ALTER TABLE products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1 CHECK(track_stock IN (0,1))"
                    )
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    "INSERT OR IGNORE INTO meta VALUES(?,?)",
                    ("session_secret", secrets.token_hex(32)),
                )
                conn.execute(f"PRAGMA user_version={VERSION}")
                conn.commit()

    def connection(self):
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA synchronous=FULL")
        return conn

    @contextmanager
    def transaction(self):
        with LOCK:
            conn = self.connection()
            try:
                conn.execute("BEGIN IMMEDIATE")
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.close()

    @contextmanager
    def read(self):
        with LOCK:
            conn = self.connection()
            try:
                conn.execute("BEGIN")
                yield conn
            finally:
                conn.rollback()
                conn.close()

    @property
    def secret(self):
        with self.read() as conn:
            return conn.execute(
                "SELECT value FROM meta WHERE key='session_secret'"
            ).fetchone()[0]

    def command(self, user, key, payload, operation):
        if not isinstance(key, str) or not 16 <= len(key) <= 128:
            raise BusinessError("idempotency_key_required")
        try:
            fingerprint = hashlib.sha256(encode(payload).encode()).hexdigest()
        except (ValueError, TypeError):
            raise BusinessError("bad_json") from None
        with self.transaction() as conn:
            old = conn.execute("SELECT * FROM commands WHERE id=?", (key,)).fetchone()
            if old:
                if old["actor_id"] != user["id"] or old["fingerprint"] != fingerprint:
                    raise BusinessError("idempotency_conflict", 409)
                return json.loads(old["response"])
            result = operation(conn)
            conn.execute(
                "INSERT INTO commands VALUES(?,?,?,?,?)",
                (key, user["id"], fingerprint, encode(result), now()),
            )
            return result
