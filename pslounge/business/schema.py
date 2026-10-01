VERSION = 2
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','operator')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS login_attempts(
 login TEXT PRIMARY KEY, attempts INTEGER NOT NULL, blocked_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_history(
 revision INTEGER PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL,
 actor_id TEXT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS shifts(
 id TEXT PRIMARY KEY, opened_at INTEGER NOT NULL, opened_by TEXT NOT NULL REFERENCES users(id),
 opening_cents INTEGER NOT NULL CHECK(opening_cents>=0),
 closed_at INTEGER, closed_by TEXT REFERENCES users(id), actual_cents INTEGER,
 expected_cents INTEGER, note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts((1)) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS products(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0),
 stock INTEGER NOT NULL CHECK(stock>=0),
 track_stock INTEGER NOT NULL DEFAULT 1 CHECK(track_stock IN (0,1)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS customers(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS payments(
 id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, shift_id TEXT REFERENCES shifts(id),
 actor_id TEXT REFERENCES users(id), created_at INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('game','product','pass','refund','cash_in','cash_out')),
 amount_cents INTEGER NOT NULL, method TEXT NOT NULL CHECK(method IN ('cash','card','transfer')),
 parent_id TEXT REFERENCES payments(id), product_id TEXT REFERENCES products(id),
 customer_id TEXT REFERENCES customers(id), quantity INTEGER NOT NULL DEFAULT 0,
 details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS payments_shift ON payments(shift_id);
CREATE TABLE IF NOT EXISTS stock_movements(
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
 quantity INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL, reason TEXT NOT NULL, payment_id TEXT REFERENCES payments(id)
);
CREATE TABLE IF NOT EXISTS pass_movements(
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
 minutes INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL, reason TEXT NOT NULL, payment_id TEXT REFERENCES payments(id)
);
CREATE TABLE IF NOT EXISTS audit(
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id),
 created_at INTEGER NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commands(
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
 fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS payments_no_update BEFORE UPDATE ON payments BEGIN
 SELECT RAISE(ABORT,'payments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_delete BEFORE DELETE ON payments BEGIN
 SELECT RAISE(ABORT,'payments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN
 SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN
 SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS stock_no_update BEFORE UPDATE ON stock_movements BEGIN
 SELECT RAISE(ABORT,'stock history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS stock_no_delete BEFORE DELETE ON stock_movements BEGIN
 SELECT RAISE(ABORT,'stock history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS pass_no_update BEFORE UPDATE ON pass_movements BEGIN
 SELECT RAISE(ABORT,'pass history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS pass_no_delete BEFORE DELETE ON pass_movements BEGIN
 SELECT RAISE(ABORT,'pass history is append-only'); END;
"""
