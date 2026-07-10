-- Migration 0002: Initial event partition (2026-07, current month)
-- Creates the monthly events partition, indexes, and the live union view.

CREATE TABLE events_2026_07 (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    x         INTEGER NOT NULL CHECK (x >= 0 AND x <= 1919),
    y         INTEGER NOT NULL CHECK (y >= 0 AND y <= 1439),
    color     TEXT    NOT NULL CHECK (color GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    user_id   TEXT    NOT NULL,
    timestamp TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_events_2026_07_xy      ON events_2026_07(x, y);
CREATE INDEX idx_events_2026_07_ts      ON events_2026_07(timestamp);
CREATE INDEX idx_events_2026_07_user_ts ON events_2026_07(user_id, timestamp);

CREATE VIEW events_live AS
    SELECT * FROM events_2026_07;
