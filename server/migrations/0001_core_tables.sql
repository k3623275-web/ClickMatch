-- Migration 0001: core tables
-- Creates all non-partitioned tables for ClickMatch

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    total_clicks  INTEGER NOT NULL DEFAULT 0 CHECK (total_clicks >= 0),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS transactions (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
    clicks_purchased INTEGER NOT NULL CHECK (clicks_purchased > 0),
    tx_hash          TEXT UNIQUE,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','rejected')),
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    approved_at      TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status, created_at);

CREATE TABLE IF NOT EXISTS competitions (
    id        TEXT PRIMARY KEY,
    phase     INTEGER NOT NULL CHECK (phase >= 1),
    starts_at TEXT NOT NULL,
    ends_at   TEXT,
    status    TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','active','finished','cancelled'))
);

CREATE TABLE IF NOT EXISTS events_aggregates (
    day         TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    click_count INTEGER NOT NULL,
    PRIMARY KEY (day, user_id)
);

CREATE TABLE IF NOT EXISTS canvas_snapshots (
    id          TEXT PRIMARY KEY,
    r2_key      TEXT NOT NULL,
    event_id_at INTEGER NOT NULL,
    size_bytes  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON canvas_snapshots(created_at);

-- Seed a Phase 1 competition (1-week duration by default)
INSERT OR IGNORE INTO competitions (id, phase, starts_at, ends_at, status)
VALUES (
    'phase-1',
    1,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+7 days'),
    'active'
);
