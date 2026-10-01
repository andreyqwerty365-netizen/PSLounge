from __future__ import annotations

import re
from werkzeug.security import check_password_hash, generate_password_hash

from .database import BusinessError, audit, now, public_user, text, uid


def credentials(data):
    login = text(data.get("login"), maximum=40).lower()
    if not re.fullmatch(r"[\w.-]{3,40}", login):
        raise BusinessError("invalid_login")
    password = data.get("password")
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise BusinessError("password_too_short")
    return login, password


def create(conn, data, actor=None):
    login, password = credentials(data)
    name = text(data.get("name"), maximum=80)
    role = data.get("role", "operator")
    if role not in ("owner", "operator"):
        raise BusinessError("invalid_role")
    if conn.execute("SELECT 1 FROM users WHERE login=?", (login,)).fetchone():
        raise BusinessError("login_exists", 409)
    identifier = uid()
    conn.execute(
        "INSERT INTO users(id,login,name,password_hash,role) VALUES(?,?,?,?,?)",
        (identifier, login, name, generate_password_hash(password), role),
    )
    user = public_user(
        conn.execute("SELECT * FROM users WHERE id=?", (identifier,)).fetchone()
    )
    audit(conn, actor or user, "user_created", {"userId": identifier, "role": role})
    return {"ok": True, "user": user}


def setup(db, data):
    with db.transaction() as conn:
        if conn.execute("SELECT 1 FROM users").fetchone():
            raise BusinessError("already_configured", 409)
        return create(conn, {**data, "role": "owner"})


def login(db, data):
    name = str(data.get("login") or "").strip().lower()[:40]
    password = data.get("password")
    with db.transaction() as conn:
        attempt = conn.execute(
            "SELECT * FROM login_attempts WHERE login=?", (name,)
        ).fetchone()
        if attempt and attempt["blocked_until"] > now():
            return None, "login_locked"
        row = conn.execute(
            "SELECT * FROM users WHERE login=? AND active=1", (name,)
        ).fetchone()
        if (
            row
            and isinstance(password, str)
            and len(password) <= 128
            and check_password_hash(row["password_hash"], password)
        ):
            conn.execute("DELETE FROM login_attempts WHERE login=?", (name,))
            audit(conn, row, "login", {})
            return public_user(row), None
        failures = (
            attempt["attempts"] if attempt and attempt["blocked_until"] == 0 else 0
        ) + 1
        blocked = now() + 300_000 if failures >= 5 else 0
        conn.execute(
            "INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)",
            (name, failures, blocked),
        )
        return None, "invalid_credentials"


def update(conn, data, actor):
    row = conn.execute("SELECT * FROM users WHERE id=?", (data.get("id"),)).fetchone()
    if row is None:
        raise BusinessError("user_not_found", 404)
    role = data.get("role", row["role"])
    if role not in ("owner", "operator"):
        raise BusinessError("invalid_role")
    active = data.get("active", bool(row["active"]))
    if not isinstance(active, bool):
        raise BusinessError("invalid_active")
    if row["active"] and row["role"] == "owner" and (not active or role != "owner"):
        count = conn.execute(
            "SELECT count(*) FROM users WHERE active=1 AND role='owner'"
        ).fetchone()[0]
        if count <= 1:
            raise BusinessError("last_owner", 409)
    password_hash = row["password_hash"]
    if data.get("password"):
        _, password = credentials({"login": row["login"], "password": data["password"]})
        password_hash = generate_password_hash(password)
    name = text(data.get("name", row["name"]), maximum=80)
    conn.execute(
        "UPDATE users SET name=?,role=?,active=?,password_hash=? WHERE id=?",
        (name, role, int(active), password_hash, row["id"]),
    )
    audit(
        conn,
        actor,
        "user_updated",
        {"userId": row["id"], "role": role, "active": active},
    )
    return {"ok": True}
