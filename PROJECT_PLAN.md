# ClickMatch — Project Master Plan

> Version: 1.0 | 2026-07-05 | Agent-S (Project Lead)

## Overview

ClickMatch is a global collaborative pixel-canvas game. Players pay $0.01 per click to set a pixel's color on a shared 1920×1440 canvas. Phase 1 is a timed global competition — no rules, free-form pixel placement until the clock runs out.

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Vanilla HTML/CSS/JS + Canvas API | No framework; lightweight & fast |
| Real-time | WebSocket via Cloudflare Durable Objects | Global edge distribution |
| Backend API | Cloudflare Workers | HTTP endpoints (auth, balance, leaderboard) |
| Database | Cloudflare D1 (SQLite) | Users, transactions, event log |
| Storage | Cloudflare R2 | Screenshot backups, video assets |
| Payment | Solana Pay / USDT (TRC-20) | Phase 1 manual confirmation OK |
| Deployment | Cloudflare Pages + Wrangler CLI | `wranger deploy` for Workers |

## Phase 1 — Free Canvas (MVP)

### Rules
- 1920×1440 pixel canvas, 16-color palette
- $0.01 per pixel click, pre-charge model ($5 = 500 clicks)
- Timer countdown, canvas freezes at deadline
- Real-time updates via WebSocket broadcast

### Required Features
- Canvas rendering (ImageData, 1920×1440, zoom/pan)
- Color picker (16 colors)
- Click → WebSocket → validate balance → broadcast
- User auth (email or wallet)
- Balance display & top-up UI
- Countdown timer & freeze logic
- Session recording (event log → future video rendering)

### NOT in Phase 1
- Phases 2-4 (locked, teaser UI only)
- Team/camp mechanics
- Special color permissions
- Crypto automatic payment (manual top-up in V1)

## Data Model (D1)

### Users
```
id TEXT PRIMARY KEY,
email TEXT UNIQUE,
balance INTEGER DEFAULT 0,        -- clicks remaining
total_clicks INTEGER DEFAULT 0,
created_at INTEGER
```

### Transactions
```
id TEXT PRIMARY KEY,
user_id TEXT,
amount_cents INTEGER,             -- USD cents
clicks_purchased INTEGER,
tx_hash TEXT,                     -- crypto tx id
status TEXT,                      -- pending / confirmed
created_at INTEGER
```

### Events (canvas history)
```
id INTEGER PRIMARY KEY AUTOINCREMENT,
x INTEGER,
y INTEGER,
color TEXT,                       -- hex
user_id TEXT,
timestamp INTEGER
```

### Competition
```
id TEXT PRIMARY KEY,
phase INTEGER DEFAULT 1,
starts_at INTEGER,
ends_at INTEGER,
status TEXT                       -- upcoming / active / ended
```

## API Design (Workers)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/register` | POST | Register with email |
| `/api/auth/login` | POST | Login, return token |
| `/api/user/me` | GET | Current user info + balance |
| `/api/canvas/state` | GET | Full canvas binary snapshot |
| `/api/competition/current` | GET | Phase info + countdown |
| `/api/topup/request` | POST | Request manual top-up |
| `/api/leaderboard` | GET | Top clickers |

## WebSocket Protocol (Durable Objects)

```
Client → Server:
  { type: "click", x: 123, y: 456, color: "#FF0000", token: "jwt..." }
  { type: "ping" }

Server → Client:
  { type: "init", canvas: <binary snapshot>, expires_at: <ts> }
  { type: "pixel", x: 123, y: 456, color: "#FF0000", user_id: "xxx" }
  { type: "countdown", seconds_left: 3600 }
  { type: "frozen" }
  { type: "error", message: "..." }
```

## Team Assignment

| Agent | Module | Deliverable |
|-------|--------|-------------|
| 后端架构师 (3010ll10ltqof1lk) | System design, Durable Objects WS protocol, D1 schema, Workers API spec | `docs/architecture.md` + `server/wrangler.toml` + DB schema |
| Python全栈工程师 (tfxjjhfnjialcuju) | Auth endpoints, balance logic, top-up flow, event logging | `server/src/` Workers code |
| 前端开发者 (54nuktoh8cd83kjj) | Canvas engine + zoom/pan + color picker + WebSocket client + timer UI | `frontend/` all files |
| 品牌视觉设计师 (qzeczsg5tg5g2p4s) | Logo, brand colors, 16-color palette design, UI polish | Assets + CSS theming |
| 数据库专家 (5auzkjz1lwo3fd5x) | D1 schema, indexing, query optimization, migration plan | `docs/db-schema.md` |
| 云原生架构专家 (a47djjquvvjn5hh9) | Cloudflare setup, Workers/Durable Objects config, R2, DNS | `docs/deployment.md` + `wrangler.toml` |
| DevOps自动化师 (qk8c3e3ry1iwy7zr) | CI/CD pipeline, wrangler deploy automation | `.github/workflows/` |
| 安全工程师 (tzqgoaexn7daprj3) | Auth review, anti-abuse (rate limiting), JWT design | `docs/security-review.md` |
| 提示词工程师 (bg0wgtn9jlge3doh) | Polish all task prompts for each agent before dispatch | Task briefs |
| 建站搭子 (op-5f04fe9a-0fae-4012-a46c-d9e235f99c8d) | Landing page / waitlist page | `frontend/landing.html` |

## Unknowns / Blockers

- [ ] Domain name (clickmatch.com / .io / .gg)
- [ ] Cloudflare account setup (must verify email + payment method for Workers paid plan)
- [ ] Crypto wallet for receiving payments
- [ ] JWT signing secret generation

## Phase 1 Timeline (target)

| Milestone | Target |
|-----------|--------|
| Architecture doc + DB schema | Day 1 |
| Canvas engine prototype | Day 2 |
| WebSocket baseline | Day 3 |
| Auth + payment flow | Day 4 |
| Integration test | Day 5 |
| Deploy to prod | Day 7 |
