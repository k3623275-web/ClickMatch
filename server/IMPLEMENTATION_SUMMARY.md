# ClickMatch Backend API — Implementation Summary

**Date:** 2026-07-10  
**Task:** Create complete Cloudflare Workers HTTP API backend

## Files Created

| File | Purpose | Size |
|------|---------|------|
| `package.json` | Project config + wrangler scripts | 504 B |
| `wrangler.toml` | Cloudflare Workers deploy config | 276 B |
| `server/tsconfig.json` | TypeScript config (strict, ES2022, bundler moduleResolution) | 418 B |
| `server/src/types.ts` | TypeScript types (User, Transaction, Event, Competition, API req/res types, JwtPayload, Env) | 2.7 KB |
| `server/src/validation.ts` | Input validation (email, password, coords, color, amount, limit, cursor) | 4.1 KB |
| `server/src/auth.ts` | JWT HS256 sign/verify + PBKDF2 password hashing (Web Crypto API, no npm deps) | 6.2 KB |
| `server/src/db.ts` | D1 database operations layer (all parameterized queries, UUID generation, leaderboard composite query) | 8.4 KB |
| `server/src/index.ts` | Main Worker entry point (all 8 HTTP endpoints + CORS + error handling) | 11.7 KB |
| `server/migrations/0001_core_tables.sql` | D1 migration: users, transactions, competitions, events_aggregates, canvas_snapshots + seed competition | 2.4 KB |
| `server/migrations/0002_events_2026_07.sql` | D1 migration: monthly event partition + events_live view | 1.1 KB |

## HTTP Endpoints Implemented

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Email + password → JWT + user |
| POST | `/api/auth/login` | No | Email + password → JWT + user |
| GET | `/api/user/me` | Bearer | Current user info + balance |
| POST | `/api/topup/request` | Bearer | Manual top-up request (Phase 1) |
| GET | `/api/canvas/state` | No | Snapshot R2 URL + competition status |
| GET | `/api/events` | Bearer | Cursor-paginated events (after_id, limit) |
| GET | `/api/competition/current` | No | Current competition info + total_clicks + online_players |
| GET | `/api/leaderboard` | No | Top clickers ranked (combined live + aggregates query) |
| OPTIONS | `*` | No | CORS preflight |

## Design Decisions

1. **No npm dependencies** — Uses Web Crypto API for JWT (HS256, HMAC-SHA256) and PBKDF2-SHA256 for password hashing (100k iterations). 24h token expiry.

2. **Parameterized SQL everywhere** — All D1 queries use `?.bind()` to prevent SQL injection. Follows the query patterns from schema.md §3.

3. **Leaderboard** — Uses the composite query from schema.md §3.1: `events_live` COUNT + `events_aggregates` SUM, joined to `users`. Emails are masked as `u***@example.com`.

4. **Error responses** — All endpoints return `{ error: string, code?: number }` with appropriate HTTP status codes (400/401/404/409/500).

5. **CORS** — `Access-Control-Allow-Origin: *` on all responses with preflight OPTIONS handler.

6. **Cursor pagination** — Events use `id > after_id ORDER BY id ASC LIMIT n+1` pattern; fetches one extra row to detect `next_cursor`.

7. **Online player count** — Distinct users with clicks in last 5 minutes (fast proxy; DO connection count would be more accurate).

8. **Password hash format** — `{iterations}:{salt_b64url}:{hash_b64url}` — self-describing, migration-friendly.

## Security Considerations

- JWT secret from `env.JWT_SECRET` (set via `wrangler secret put`)
- Balance check is done in Durable Object (not this Worker) for atomicity
- PBKDF2 chosen over bcrypt because Workers CPU limits make bcrypt impractical at edge
- Password comparison uses constant-time byte-wise XOR to prevent timing attacks
- Coordinates validated server-side (0-1919, 0-1439)
- Color validated as 6-char hex via `CHECK (color GLOB '[0-9A-Fa-f]{6}')` at DB level

## What's NOT in This Worker

- WebSocket handling → Separate Durable Object (`CanvasRoom`)
- Click placement logic → DO handles atomic balance decrement + event insert + broadcast
- Snapshot generation → Cron Worker
- Admin confirmation endpoint → Will add in Phase 1 extension
