# ClickMatch — Database Schema Design

> **Target**: Cloudflare D1 (SQLite-compatible, serverless edge)
> **Canvas**: 1920×1440 px | **Phase 1**: Free-for-all pixel competition
> **Load**: ~100K clicks/day → ~36.5M event rows/year

---

## 1. Table Definitions

### 1.1 users

```sql
CREATE TABLE users (
    id           TEXT PRIMARY KEY,          -- UUID v4, generated server-side
    email        TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,            -- bcrypt, 60 chars
    balance      INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    total_clicks INTEGER NOT NULL DEFAULT 0 CHECK (total_clicks >= 0),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_users_email ON users(email);
```

**Design rationale**:
- UUID as TEXT because D1/SQLite has no native UUID type; string comparison is fast enough for auth lookups. Email uses UNIQUE + index because it's the primary login identifier — the fastest path for `SELECT … WHERE email = ?` during sign-in.
- Balance and total_clicks are counters, not derived from events — avoids scanning 36M rows for a simple "how many clicks do I have left?" check. Balance is decremented atomically per click placement (optimistic concurrency via `UPDATE users SET balance = balance - 1 WHERE id = ? AND balance > 0`).

### 1.2 transactions

```sql
CREATE TABLE transactions (
    id               TEXT PRIMARY KEY,      -- UUID v4
    user_id          TEXT NOT NULL,
    amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
    clicks_purchased INTEGER NOT NULL CHECK (clicks_purchased > 0),
    tx_hash          TEXT UNIQUE,           -- on-chain txn hash; NULL until broadcast
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','rejected')),
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    approved_at      TEXT,

    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id, created_at);
CREATE INDEX idx_transactions_status   ON transactions(status, created_at);
```

**Design rationale**:
- Amount and clicks are separate — a promo could charge $1 for 500 clicks (deviating from 1:1). tx_hash is NULL-able because payment confirmation is async; the UI shows "pending" until the payment provider callback hits the API and marks it confirmed.
- CHECK on amount/clicks prevents zero-value rows that could slip through from payment provider edge cases. The composite index on `(user_id, created_at)` serves the user's transaction history page directly.

### 1.3 events (core — partitioned)

The events table is **partitioned by month** using physical D1 tables + a UNION ALL view. D1/SQLite has no native partition support.

```sql
-- Monthly partition template. Create these programmatically via migration.
-- e.g., events_2026_07, events_2026_08, ...

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

-- Live view: unions all active-month partitions. Recreated on month rollover.
CREATE VIEW events_live AS
    SELECT * FROM events_2026_06
    UNION ALL
    SELECT * FROM events_2026_07;
```

**Partition management SQL** (run via migration/worker on month boundary):

```sql
-- 1. Create new month table
CREATE TABLE events_2026_08 (...same template...);

-- 2. Create indexes on new table
CREATE INDEX idx_events_2026_08_xy      ON events_2026_08(x, y);
CREATE INDEX idx_events_2026_08_ts      ON events_2026_08(timestamp);
CREATE INDEX idx_events_2026_08_user_ts ON events_2026_08(user_id, timestamp);

-- 3. Rebuild view (keep last 3 months active)
DROP VIEW IF EXISTS events_live;
CREATE VIEW events_live AS
    SELECT * FROM events_2026_06
    UNION ALL
    SELECT * FROM events_2026_07
    UNION ALL
    SELECT * FROM events_2026_08;

-- 4. Archive oldest active partition to R2 as JSONL dump
--    (then DROP TABLE events_2026_06)
```

**Design rationale**:
- Partitioning by month is mandatory at 36.5M rows/year — a single-table approach would degrade index B-tree performance and make full-table COUNT(*) scans prohibitively slow. Three active months (~9M rows) keeps the UNION ALL view responsive while older data is archived to R2.
- `x,y` index serves the canvas rendering query (what's the latest color at pixel X,Y?) and heatmap aggregation. `timestamp` index powers replay/time-range queries. `user_id,timestamp` composite serves the per-user click history.
- AUTOINCREMENT INTEGER PK is deliberate: it provides a globally-ordered id that the front-end can use for replay cursors ("render events up to id=12458821"), which is cheaper than timestamp-based pagination in SQLite.

### 1.4 competitions

```sql
CREATE TABLE competitions (
    id        TEXT PRIMARY KEY,            -- UUID v4 or short slug e.g. "phase-1"
    phase     INTEGER NOT NULL CHECK (phase >= 1),
    starts_at TEXT NOT NULL,
    ends_at   TEXT,
    status    TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','active','finished','cancelled'))
);
```

**Design rationale**:
- Phase is an integer so competition seasons can be compared and sorted naturally. ends_at is nullable because an active competition may not have a fixed end date (extended by admin decision).
- Minimal table — competition metadata (rules, prize pool, region restrictions) belongs in a companion `competition_configs` JSON blob or a separate key-value table. This keeps the core table small and queryable without column bloat.

### 1.5 canvas_snapshots

```sql
CREATE TABLE canvas_snapshots (
    id          TEXT PRIMARY KEY,          -- UUID v4, or "latest" as special sentinel
    r2_key      TEXT NOT NULL,             -- R2 object key, e.g. "snapshots/2026-07-05T1730Z.png"
    event_id_at INTEGER NOT NULL,          -- events.id cursor: all events <= this id are baked in
    size_bytes  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_snapshots_created ON canvas_snapshots(created_at);
```

**Design rationale**:
- Snapshots store an R2 key, not raw bytes — D1 has per-row size limits and storing 8MB+ PNGs inline would blow storage and query budgets. `event_id_at` is the low-water-mark cursor: a new client connects, receives the latest snapshot R2 URL + its `event_id_at`, then streams only events with `id > event_id_at` from the events view — this avoids replaying 36M rows on every page load.
- Snapshots are generated by a cron worker (every 5-10 minutes) and uploaded to R2. The DB only stores the key reference, keeping D1 storage minimal.

---

## 2. Events Growth Estimate & Archive Strategy

### Growth projection

| Period | Rows | Size (data) | Size (+indexes) |
|--------|------|-------------|-----------------|
| 1 day  | 100K | ~4 MB       | ~10 MB          |
| 1 month | 3M  | ~120 MB     | ~300 MB         |
| 3 months | 9M | ~360 MB     | ~900 MB         |
| 1 year | 36.5M | ~1.5 GB   | ~3.8 GB          |

*Per-row estimate: 33 bytes data (INTEGER id=8 + 2×INTEGER coords=8 + TEXT color=8 + TEXT user_id=37 + TEXT timestamp=20 + overhead), indexes add ~2.5× overhead.*

### Archive tiers

```
┌──────────────────────────────────────────────┐
│  Hot (D1)          │  months T-2, T-1, T     │  9M rows, ~900 MB
│  ─ indexed, queried in real-time             │
├──────────────────────────────────────────────┤
│  Warm (R2 + D1)    │  months T-5 to T-3      │  R2: JSONL gzip
│  ─ R2 for bulk; D1 keeps summary aggregates  │  D1: daily counts only
│    (events_aggregates table below)           │
├──────────────────────────────────────────────┤
│  Cold (R2 only)    │  older than T-5         │  JSONL gzip, partitioned
│  ─ loaded on-demand for historical replay    │  by month folder
└──────────────────────────────────────────────┘
```

### Archive aggregates table (Warm tier — stays in D1)

```sql
CREATE TABLE events_aggregates (
    day        TEXT NOT NULL,            -- '2026-06-15'
    user_id    TEXT NOT NULL,
    click_count INTEGER NOT NULL,

    PRIMARY KEY (day, user_id)
);
```

This enables leaderboard queries across archived data without touching R2: `SUM(click_count)` across `events_aggregates` + live counts from `events_live`. At ~3MB/year, this stays in D1 forever.

### Archive procedure (monthly cron)

1. Export oldest active partition to R2 as newline-delimited JSON (gzipped): `events_2026_05.jsonl.gz`
2. Populate `events_aggregates` with daily per-user counts from the archived partition
3. `DROP TABLE events_2026_05` from D1
4. Rebuild `events_live` view with the new 3-month window

### Admin replay (cold data access)

Historical replay loads the JSONL archive from R2 into a temporary D1 table or streams it directly to the client via paginated API. R2 range requests support seeking by byte offset, enabling efficient seek into any month's data without downloading the full archive.

---

## 3. Query Patterns

### 3.1 Leaderboard (Top 50 users by clicks)

```sql
-- Composite: live + archived aggregates
SELECT
    u.id,
    u.email,
    COALESCE(live.cnt, 0) + COALESCE(arch.cnt, 0) AS total
FROM users u
LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt
    FROM events_live
    GROUP BY user_id
) live ON live.user_id = u.id
LEFT JOIN (
    SELECT user_id, SUM(click_count) AS cnt
    FROM events_aggregates
    GROUP BY user_id
) arch ON arch.user_id = u.id
ORDER BY total DESC
LIMIT 50;
```

**Why this over `users.total_clicks`**: total_clicks is a counter updated by the application layer on each click — it's fast but eventually-consistent. The aggregate query crosses live + archived data and serves as the ground-truth reconciliation source for periodic leaderboard snapshots.

### 3.2 Current pixel color at (x, y)

```sql
SELECT color, user_id, timestamp
FROM events_live
WHERE x = ? AND y = ?
ORDER BY timestamp DESC
LIMIT 1;
```

The `(x, y)` composite index makes this a direct B-tree seek. For the full canvas render (1920×1440 = 2.76M pixels), use a snapshot — never query 2.76M individual pixels.

### 3.3 Canvas replay (time-range streaming)

```sql
SELECT x, y, color, user_id, timestamp
FROM events_live
WHERE id > ?           -- cursor-based pagination
ORDER BY id ASC
LIMIT 1000;
```

Cursor on AUTOINCREMENT `id` is O(log N) index seek, versus timestamp-based ordering which requires a full sort in SQLite. The client remembers the last `id` it received and asks for the next batch.

### 3.4 Click heatmap (aggregation for visualization)

```sql
SELECT x, y, COUNT(*) AS intensity
FROM events_live
WHERE timestamp >= ?
GROUP BY x, y
ORDER BY intensity DESC
LIMIT 500;
```

The `(x, y)` index serves GROUP BY efficiently since SQLite's query planner can use the index for grouping when the columns are a prefix. For full-canvas heatmaps, pre-compute and cache this as a snapshot.

### 3.5 User click history (paginated)

```sql
SELECT x, y, color, timestamp
FROM events_live
WHERE user_id = ?
ORDER BY timestamp DESC
LIMIT 50
OFFSET ?;
```

The `(user_id, timestamp)` composite index covers this entirely — no table access needed, index-only scan.

### 3.6 Pixel battle — who owns a coordinate most?

```sql
SELECT user_id, COUNT(*) AS claims
FROM events_live
WHERE x = ? AND y = ?
GROUP BY user_id
ORDER BY claims DESC
LIMIT 5;
```

### 3.7 Balance check (atomic decrement pattern)

```sql
-- Step 1: Atomically claim a click
UPDATE users
SET balance = balance - 1,
    total_clicks = total_clicks + 1
WHERE id = ?
  AND balance > 0;

-- Step 2: If rows_affected == 1, insert the event
INSERT INTO events_2026_07 (x, y, color, user_id, timestamp)
VALUES (?, ?, ?, ?, ?);

-- Step 3: If rows_affected == 0, user is out of balance → return 402 Payment Required
```

This is lock-free optimistic concurrency — D1's single-writer model guarantees the balance check is atomic per statement. No SELECT-then-UPDATE race condition possible.

### 3.8 New client bootstrap (snapshot + delta)

```json
// API response: GET /canvas/state
{
  "snapshot_url": "https://r2.clickmatch.io/snapshots/2026-07-05T1730Z.png",
  "snapshot_id_at": 12458821,
  "live_events_since": "https://api.clickmatch.io/events?after_id=12458821&limit=500"
}
```

Client loads snapshot PNG (instant canvas), then streams events with `id > 12458821` to catch up. This is < 1 second for any new connection, versus 30+ seconds to replay millions of events.

---

## 4. D1-Specific Considerations

| Concern | Handling |
|---------|----------|
| **Row limit** | D1 unlimited rows, but practical performance degrades past ~10M/table. Partitioning at 3M/month keeps each partition fast. |
| **Concurrency** | D1 is single-writer. Click placement is sequential per DB, but 100K/day = ~1.2 writes/second average. D1 handles 10-50 writes/sec comfortably. If usage spikes, shard events by region into separate D1 databases. |
| **Storage** | D1 limit is 10GB per database (paid). At ~3.8GB/year with indexes for the hot tier, we have headroom for 2+ years before cold-archive cleanup is needed. |
| **Backup** | D1 provides point-in-time restore. Additionally, export events as JSONL to R2 nightly for disaster recovery. |
| **Migrations** | Use D1's built-in migration system. Partition creation is a migration that runs on month boundary via a scheduled Worker. |

---

## 5. Full Migration Sequence (initial deploy)

```sql
-- Migration 0001: core tables

CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    balance      INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    total_clicks INTEGER NOT NULL DEFAULT 0 CHECK (total_clicks >= 0),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE transactions (
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
CREATE INDEX idx_transactions_user_id ON transactions(user_id, created_at);
CREATE INDEX idx_transactions_status   ON transactions(status, created_at);

CREATE TABLE competitions (
    id        TEXT PRIMARY KEY,
    phase     INTEGER NOT NULL CHECK (phase >= 1),
    starts_at TEXT NOT NULL,
    ends_at   TEXT,
    status    TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','active','finished','cancelled'))
);

CREATE TABLE events_aggregates (
    day         TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    click_count INTEGER NOT NULL,
    PRIMARY KEY (day, user_id)
);

CREATE TABLE canvas_snapshots (
    id           TEXT PRIMARY KEY,
    r2_key       TEXT NOT NULL,
    event_id_at  INTEGER NOT NULL,
    size_bytes   INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_snapshots_created ON canvas_snapshots(created_at);
```

```sql
-- Migration 0002: initial event partition (current month)
-- Run at deploy time; month placeholder replaced by script.

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
```

---

## 6. API ↔ Schema Alignment Notes

*(To be reconciled with the API architect's OpenAPI spec)*

| API Endpoint | Tables touched | Key query pattern |
|-------------|----------------|-------------------|
| `POST /auth/register` | users | INSERT |
| `POST /auth/login` | users | SELECT by email |
| `POST /transactions` | transactions | INSERT (pending) |
| `POST /transactions/webhook` | transactions, users | UPDATE status + UPDATE balance |
| `GET /users/me` | users | SELECT by id |
| `POST /clicks` | users, events_YYYY_MM | Atomic UPDATE balance + INSERT event |
| `GET /canvas/state` | canvas_snapshots, events_live | Snapshot R2 URL + events cursor |
| `GET /events` | events_live | Cursor-paginated by id |
| `GET /leaderboard` | events_live, events_aggregates, users | Aggregated COUNT with archive join |
| `GET /canvas/heatmap` | events_live | GROUP BY x,y |
| `GET /canvas/pixel?x=&y=` | events_live | Point query with LIMIT 1 ORDER BY timestamp DESC |

### Design principles shared with API layer

1. **Balance is the source of truth for click allowance** — the API must check `balance > 0` atomically in the same UPDATE statement, not via a separate SELECT.
2. **Event insertion returns the generated id** — the API response includes it so the client can use it as a cursor for live replay.
3. **Snapshot generation is a background job** — the API never blocks on snapshot creation. It always returns the latest available snapshot.
4. **Leaderboard is eventually consistent** — aggregate data lags by up to 30 minutes (the archive window). Real-time ranks use `events_live` only; official rankings use the combined query.
