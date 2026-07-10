-- Migration 0002: initial event partition
-- Creates the first monthly event partition and the events_live view.
-- Month is hardcoded to 2026_07 here; for production, generate this
-- dynamically via a script that checks the current month.

CREATE TABLE IF NOT EXISTS events_2026_07 (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    x         INTEGER NOT NULL CHECK (x >= 0 AND x <= 1919),
    y         INTEGER NOT NULL CHECK (y >= 0 AND y <= 1439),
    color     TEXT    NOT NULL CHECK (color GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    user_id   TEXT    NOT NULL,
    timestamp TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_events_2026_07_xy      ON events_2026_07(x, y);
CREATE INDEX IF NOT EXISTS idx_events_2026_07_ts      ON events_2026_07(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_2026_07_user_ts ON events_2026_07(user_id, timestamp);

-- Create/replace the live events view
DROP VIEW IF EXISTS events_live;
CREATE VIEW events_live AS
    SELECT * FROM events_2026_07;
