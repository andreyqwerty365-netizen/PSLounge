"""Authenticated local business API; licenses remain checked by the original verifier."""

from __future__ import annotations

from datetime import timedelta
from functools import wraps
from io import BytesIO
import json
import secrets

from flask import Blueprint, g, jsonify, request, send_file, session
from flask.sessions import SecureCookieSessionInterface

from ..state import _is_valid_state_payload
from . import accounts, backups, catalog, shifts, snapshots
from .database import BusinessError, Database, public_user


def register(app, license_check, directory, legacy_supplier):
    cache = {}

    def database():
        path = directory()
        if path not in cache:
            db = Database(path)
            snapshots.initialize(db, legacy_supplier)
            cache[path] = db
        db = cache[path]
        try:
            db.backup_status = backups.daily(db)
        except OSError:
            db.backup_status = "failed"
        return db

    class LocalSessions(SecureCookieSessionInterface):
        def get_signing_serializer(self, application):
            application.secret_key = database().secret
            return super().get_signing_serializer(application)

    app.session_interface = LocalSessions()
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        MAX_CONTENT_LENGTH=backups.MAX_BYTES + 1024,
    )
    api = Blueprint("business", __name__)

    @app.errorhandler(BusinessError)
    def business_error(error):
        return jsonify(ok=False, error=error.code, **error.extra), error.status

    @api.before_request
    def licensed():
        return license_check()

    def csrf():
        token = session.get("csrf")
        if not token or not secrets.compare_digest(
            str(request.headers.get("X-PSLounge-CSRF", "")), token
        ):
            raise BusinessError("csrf_required", 403)

    def authorize(owner=False):
        denied = license_check()
        if denied:
            return denied
        with database().read() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE id=? AND active=1", (session.get("user"),)
            ).fetchone()
            if row is None:
                raise BusinessError("login_required", 401)
            g.user = public_user(row)
        if owner and g.user["role"] != "owner":
            raise BusinessError("owner_required", 403)
        if request.method != "GET":
            csrf()
        return None

    def protected(owner=False):
        def decorate(fn):
            @wraps(fn)
            def wrapper(*args, **kwargs):
                denied = authorize(owner)
                return denied if denied else fn(*args, **kwargs)

            return wrapper

        return decorate

    def payload():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise BusinessError("bad_json")
        return value

    @api.get("/api/accounts/status")
    def account_status():
        session.setdefault("csrf", secrets.token_hex(32))
        with database().read() as conn:
            configured = bool(conn.execute("SELECT 1 FROM users").fetchone())
            row = conn.execute(
                "SELECT * FROM users WHERE id=? AND active=1", (session.get("user"),)
            ).fetchone()
            return jsonify(
                ok=True,
                configured=configured,
                user=public_user(row) if row else None,
                csrf=session["csrf"],
            )

    def sign_in(user):
        session.clear()
        session.update(user=user["id"], csrf=secrets.token_hex(32))
        session.permanent = True
        return jsonify(ok=True, user=user, csrf=session["csrf"])

    @api.post("/api/accounts/setup")
    def setup():
        csrf()
        return sign_in(accounts.setup(database(), payload())["user"])

    @api.post("/api/accounts/login")
    def login():
        csrf()
        user, error = accounts.login(database(), payload())
        if error:
            raise BusinessError(error, 429 if error == "login_locked" else 401)
        return sign_in(user)

    @api.post("/api/accounts/logout")
    @protected()
    def logout():
        session.clear()
        return jsonify(ok=True)

    @api.get("/api/business")
    @protected()
    def status():
        with database().read() as conn:
            owner = g.user["role"] == "owner"
            rows = conn.execute(
                "SELECT * FROM shifts ORDER BY opened_at DESC LIMIT 30"
            ).fetchall()
            shift_list = [
                shifts.summary(conn, row)
                for row in rows
                if owner or row["opened_by"] == g.user["id"]
            ]
            active = conn.execute(
                "SELECT * FROM shifts WHERE closed_at IS NULL"
            ).fetchone()
            products = [
                dict(row)
                for row in conn.execute("SELECT * FROM products ORDER BY name")
            ]
            customers = [
                dict(row)
                for row in conn.execute("""SELECT c.*,coalesce(sum(m.minutes),0) AS minutes
                FROM customers c LEFT JOIN pass_movements m ON m.customer_id=c.id GROUP BY c.id ORDER BY c.name""")
            ]
            where, params = (
                ("", ()) if owner else ("WHERE p.actor_id=?", (g.user["id"],))
            )
            payments = []
            for row in conn.execute(
                f"""SELECT p.*,u.name AS operator,
                p.amount_cents+coalesce((SELECT sum(r.amount_cents) FROM payments r WHERE r.parent_id=p.id),0) AS refundable_cents
                FROM payments p LEFT JOIN users u ON u.id=p.actor_id {where} ORDER BY p.created_at DESC,p.rowid DESC LIMIT 100""",
                params,
            ):
                item = dict(row)
                item["details"] = json.loads(item["details"])
                payments.append(item)
            users = (
                [
                    public_user(row)
                    for row in conn.execute("SELECT * FROM users ORDER BY name")
                ]
                if owner
                else []
            )
            audit = (
                [
                    dict(row)
                    for row in conn.execute("""SELECT a.*,u.name AS operator FROM audit a
                LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100""")
                ]
                if owner
                else []
            )
            # Imported history is shown separately from current recorded receipts.
            totals = (
                [
                    dict(row)
                    for row in conn.execute("""SELECT kind,method,sum(amount_cents) AS cents,
                shift_id IS NULL AS imported FROM payments GROUP BY kind,method,imported""")
                ]
                if owner
                else []
            )
            return jsonify(
                ok=True,
                user=g.user,
                activeShift=shifts.summary(conn, active) if active else None,
                shifts=shift_list,
                products=products,
                customers=customers,
                payments=payments,
                users=users,
                audit=audit,
                totals=totals,
                backupStatus=database().backup_status,
            )

    operations = {
        "shifts/open": (shifts.open_shift, False),
        "shifts/close": (shifts.close_shift, False),
        "cash": (shifts.cash_movement, False),
        "refund": (shifts.refund, True),
        "products/save": (catalog.product_save, True),
        "products/sell": (catalog.sell, False),
        "customers/create": (catalog.customer_create, False),
        "passes/sell": (catalog.pass_sell, False),
        "passes/redeem": (catalog.pass_redeem, False),
        "users/create": (
            lambda conn, user, data: accounts.create(conn, data, user),
            True,
        ),
        "users/save": (
            lambda conn, user, data: accounts.update(conn, data, user),
            True,
        ),
    }

    @api.post("/api/business/<path:operation>")
    def execute(operation):
        if operation not in operations:
            raise BusinessError("not_found", 404)
        handler, owner = operations[operation]
        denied = authorize(owner)
        if denied:
            return denied
        data = payload()
        result = database().command(
            g.user,
            request.headers.get("X-Idempotency-Key"),
            {"operation": operation, "data": data},
            lambda conn: handler(conn, g.user, data),
        )
        return jsonify(result)

    @api.get("/api/business-backup.sqlite3")
    @protected(owner=True)
    def download_backup():
        return send_file(
            backups.export(database()),
            mimetype="application/vnd.sqlite3",
            as_attachment=True,
            download_name="PSLounge_Backup.sqlite3",
        )

    @api.post("/api/business-restore")
    @protected(owner=True)
    def restore_backup():
        result = backups.restore(database(), request.get_data(), g.user)
        session.clear()
        return jsonify(result)

    @api.get("/api/business-ledger.csv")
    @protected(owner=True)
    def ledger_csv():
        import csv
        from io import StringIO

        stream = StringIO()
        writer = csv.writer(stream, delimiter=";")
        writer.writerow(
            [
                "ID",
                "Timestamp",
                "Shift",
                "Operator",
                "Kind",
                "Amount RUB",
                "Method",
                "Original payment",
            ]
        )
        with database().read() as conn:
            for row in conn.execute("SELECT * FROM payments ORDER BY created_at,rowid"):
                writer.writerow(
                    [
                        row["id"],
                        row["created_at"],
                        row["shift_id"],
                        row["actor_id"],
                        row["kind"],
                        f"{row['amount_cents'] / 100:.2f}",
                        row["method"],
                        row["parent_id"],
                    ]
                )
        return send_file(
            BytesIO(stream.getvalue().encode("utf-8-sig")),
            mimetype="text/csv",
            as_attachment=True,
            download_name="PSLounge_Ledger.csv",
        )

    app.register_blueprint(api)

    def read_state():
        with database().read() as conn:
            return snapshots.load(conn)

    def save_state():
        denied = authorize()
        if denied:
            return denied
        data = payload()
        if not _is_valid_state_payload(data):
            raise BusinessError("invalid_state_shape")
        return jsonify(
            database().command(
                g.user,
                request.headers.get("X-Idempotency-Key"),
                {"operation": "state", "data": data},
                lambda conn: snapshots.save(conn, data, g.user),
            )
        )

    return authorize, read_state, save_state
