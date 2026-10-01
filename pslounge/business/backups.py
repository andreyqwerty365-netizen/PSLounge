from __future__ import annotations

from io import BytesIO
import os
from pathlib import Path
import sqlite3
import secrets
import tempfile

from ..state import _is_valid_state_payload
from .database import BusinessError, DB_NAME, LOCK, audit, now
from .schema import SCHEMA, VERSION

MAX_BYTES = 32 * 1024 * 1024


def export(db):
    with LOCK:
        with tempfile.TemporaryDirectory(dir=db.directory) as directory:
            target = Path(directory) / DB_NAME
            source, destination = db.connection(), sqlite3.connect(target)
            try:
                source.backup(destination)
            finally:
                source.close()
                destination.close()
            return BytesIO(target.read_bytes())


def restore(db, data, user):
    if len(data) > MAX_BYTES or not data.startswith(b"SQLite format 3\x00"):
        raise BusinessError("invalid_backup")
    with LOCK:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=db.directory, suffix=".restore", delete=False
            ) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            connection = sqlite3.connect(f"{temporary.as_uri()}?mode=ro", uri=True)
            try:
                import json

                reference = sqlite3.connect(":memory:")
                try:
                    reference.executescript(SCHEMA)
                    expected = reference.execute(
                        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                    ).fetchall()
                    actual = connection.execute(
                        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                    ).fetchall()
                    if actual != expected:
                        # Recognize the single supported v1 -> v2 column migration as well.
                        reference.close()
                        reference = sqlite3.connect(":memory:")
                        legacy_schema = SCHEMA.replace(
                            " track_stock INTEGER NOT NULL DEFAULT 1 CHECK(track_stock IN (0,1)),",
                            "",
                        )
                        reference.executescript(legacy_schema)
                        reference.execute(
                            "ALTER TABLE products ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1 CHECK(track_stock IN (0,1))"
                        )
                        migrated = reference.execute(
                            "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                        ).fetchall()
                        if actual != migrated:
                            raise BusinessError("invalid_backup_schema")
                finally:
                    reference.close()
                if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise BusinessError("invalid_backup")
                if connection.execute("PRAGMA user_version").fetchone()[0] != VERSION:
                    raise BusinessError("backup_version_mismatch")
                if connection.execute("PRAGMA foreign_key_check").fetchone():
                    raise BusinessError("invalid_backup")
                for table in (
                    "meta",
                    "users",
                    "snapshots",
                    "payments",
                    "shifts",
                    "products",
                    "customers",
                    "audit",
                    "commands",
                    "stock_movements",
                    "pass_movements",
                ):
                    connection.execute(f"SELECT * FROM {table} LIMIT 0")
                if not connection.execute(
                    "SELECT 1 FROM users WHERE role='owner' AND active=1"
                ).fetchone():
                    raise BusinessError("invalid_backup")
                secret = connection.execute(
                    "SELECT value FROM meta WHERE key='session_secret'"
                ).fetchone()
                if not secret or len(secret[0]) < 32:
                    raise BusinessError("invalid_backup")
                row = connection.execute(
                    "SELECT data,revision FROM snapshots WHERE id=1"
                ).fetchone()
                if not row or (
                    row[1] > 0 and not _is_valid_state_payload(json.loads(row[0]))
                ):
                    raise BusinessError("invalid_backup")
            finally:
                connection.close()
            archive = db.directory / "database_backups"
            archive.mkdir(exist_ok=True)
            prior = archive / f"before-restore-{now()}.sqlite3"
            prior.write_bytes(export(db).getvalue())
            # Restoring is an explicit owner operation; the previous DB is retained.
            os.replace(temporary, db.path)
            with db.transaction() as conn:
                conn.execute(
                    "UPDATE meta SET value=? WHERE key='session_secret'",
                    (secrets.token_hex(32),),
                )
                restored_user = conn.execute(
                    "SELECT * FROM users WHERE id=?", (user["id"],)
                ).fetchone()
                audit(
                    conn,
                    restored_user,
                    "database_restored",
                    {"previousDatabase": prior.name},
                )
            return {"ok": True, "reauthenticate": True}
        except (sqlite3.Error, ValueError, KeyError, TypeError):
            raise BusinessError("invalid_backup") from None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def daily(db):
    """Consistent daily recovery copy; never trims financial records or manual archives."""
    from datetime import datetime

    with LOCK:
        with db.read() as conn:
            if not conn.execute(
                "SELECT 1 FROM users WHERE role='owner' AND active=1"
            ).fetchone():
                return None
            snapshot = conn.execute(
                "SELECT revision FROM snapshots WHERE id=1"
            ).fetchone()
            if not snapshot or snapshot[0] == 0:
                return None
        archive = db.directory / "database_backups"
        archive.mkdir(exist_ok=True)
        target = archive / f"daily-{datetime.now():%Y-%m-%d}.sqlite3"
        if not target.exists():
            with tempfile.NamedTemporaryFile(
                dir=archive, suffix=".tmp", delete=False
            ) as stream:
                temporary = Path(stream.name)
                try:
                    stream.write(export(db).getvalue())
                    stream.flush()
                    os.fsync(stream.fileno())
                finally:
                    stream.close()
            try:
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            for old in sorted(archive.glob("daily-????-??-??.sqlite3"))[:-14]:
                old.unlink()
        return target.name
