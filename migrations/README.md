# ClickMatch — Database Migrations

Migrations for the Cloudflare D1 database (`clickmatch-db`). Run in order.
All SQL is D1/SQLite compatible.

## Quick Start

```bash
# === Local development (--local flag runs against a local SQLite copy) ===

npx wrangler d1 execute clickmatch-db --local --file=./migrations/0001_core.sql
npx wrangler d1 execute clickmatch-db --local --file=./migrations/0002_events.sql
npx wrangler d1 execute clickmatch-db --local --file=./migrations/0003_seed.sql

# === Production (no --local flag; targets the remote D1 database) ===

npx wrangler d1 execute clickmatch-db --file=./migrations/0001_core.sql
npx wrangler d1 execute clickmatch-db --file=./migrations/0002_events.sql
npx wrangler d1 execute clickmatch-db --file=./migrations/0003_seed.sql
```

## Migration Overview

| File              | What It Creates                                             |
|-------------------|-------------------------------------------------------------|
| `0001_core.sql`   | `users`, `transactions`, `competitions`, `events_aggregates`, `canvas_snapshots` + indexes |
| `0002_events.sql` | `events_2026_07` partition + indexes + `events_live` view   |
| `0003_seed.sql`   | Phase 1 competition (active) + demo user (`demo@clickmatch.io`, 100 clicks) |

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed (`npm install -g wrangler`)
- Authenticated with Cloudflare (`npx wrangler login`)
- `wrangler.toml` configured with a `[[d1_databases]]` binding named `clickmatch-db`

## Monthly Partition Management

When a new month rolls over, create the next partition and rebuild the view:

```sql
-- 1. Create next month's table (e.g., for August 2026)
CREATE TABLE events_2026_08 (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    x         INTEGER NOT NULL CHECK (x >= 0 AND x <= 1919),
    y         INTEGER NOT NULL CHECK (y >= 0 AND y <= 1439),
    color     TEXT    NOT NULL CHECK (color GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    user_id   TEXT    NOT NULL,
    timestamp TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_events_2026_08_xy      ON events_2026_08(x, y);
CREATE INDEX idx_events_2026_08_ts      ON events_2026_08(timestamp);
CREATE INDEX idx_events_2026_08_user_ts ON events_2026_08(user_id, timestamp);

-- 2. Rebuild live view (keep last 3 active months)
DROP VIEW IF EXISTS events_live;
CREATE VIEW events_live AS
    SELECT * FROM events_2026_06
    UNION ALL
    SELECT * FROM events_2026_07
    UNION ALL
    SELECT * FROM events_2026_08;

-- 3. Archive the oldest partition to R2, then drop it
-- DROP TABLE events_2026_06;
```

See `docs/schema.md` §2 for the full archive strategy.
