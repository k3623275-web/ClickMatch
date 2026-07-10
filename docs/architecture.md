# ClickMatch — System Architecture

> Version: 1.0 | Phase 1 — Free Canvas Competition
> Target: Cloudflare Workers + Durable Objects + D1 + R2 + Pages

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     USER BROWSER                        │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────┐  │
│  │ Canvas   │  │ WebSocket │  │ HTTP Client (fetch) │  │
│  │ Engine   │  │ Client    │  │                     │  │
│  └────┬─────┘  └─────┬─────┘  └──────────┬─────────┘  │
└───────┼──────────────┼───────────────────┼────────────┘
        │              │                   │
        │   static     │  wss://           │  https://
        │   assets     │                   │
        ▼              ▼                   ▼
┌───────────┐  ┌──────────────┐  ┌──────────────────┐
│  Pages    │  │   Durable    │  │    Workers       │
│  (CDN)    │  │   Object     │  │    (HTTP API)    │
│           │  │  CanvasRoom  │  │                  │
│ index.html│  │              │  │  auth worker     │
│ *.js      │  │  - 画布状态   │  │  api worker      │
│ *.css     │  │  - WS连接池  │  │                  │
│           │  │  - 广播      │  │                  │
└───────────┘  └──────┬───────┘  └────────┬─────────┘
                      │                   │
                      │  D1 API           │  D1 API + R2 API
                      ▼                   ▼
              ┌──────────────────────────────────────┐
              │           Cloudflare D1               │
              │  users | transactions | events_*      │
              │  competitions | canvas_snapshots      │
              │  events_aggregates                    │
              └──────────────────────────────────────┘
                              │
                              ▼
              ┌──────────────────────────────────────┐
              │           Cloudflare R2               │
              │  canvas snapshots (PNG)               │
              │  archived events (JSONL.gz)           │
              │  static assets backup                 │
              └──────────────────────────────────────┘
```

## Data Flow

### Click Pixel Flow (hot path — every click)

```
Browser                    Durable Object              D1
  │                             │                       │
  │──WS: {type:"click",        │                       │
  │   x,y,color,token}────────►│                       │
  │                             │──Verify JWT           │
  │                             │──UPDATE users         │
  │                             │  SET balance=bal-1   │
  │                             │  WHERE id=? AND      │
  │                             │  balance>0───────────►│
  │                             │◄──rows_affected=1────│
  │                             │──INSERT INTO          │
  │                             │  events_YYYY_MM──────►│
  │                             │◄──new event id───────│
  │◄──WS: {type:"pixel",       │                       │
  │   x,y,color,user_id}──────│                       │
```

### New Client Bootstrap Flow

```
Browser                    Worker                    D1/R2
  │                          │                         │
  │──GET /api/canvas/state──►│                         │
  │                          │──SELECT latest snapshot │
  │                          │  FROM canvas_snapshots─►│
  │                          │◄──r2_key, event_id_at──│
  │◄──{snapshot_url,         │                         │
  │    event_id_at}──────────│                         │
  │                          │                         │
  │──Load snapshot PNG      │                         │
  │  from R2 URL            │                         │
  │                          │                         │
  │──WS connect──────────────┼─────────────────────────│
  │◄──WS: {type:"init",      │                         │
  │   canvas:binary,         │                         │
  │   expires_at}            │                         │
  │                          │                         │
  │──WS: stream events       │                         │
  │  with id > event_id_at───┼─────────────────────────│
  │◄──WS: pixel updates      │                         │
```

### Top-Up Flow (manual — Phase 1)

```
Browser                    Worker                    D1
  │                          │                         │
  │──POST /api/topup/request │                         │
  │  {amount_cents:500}─────►│                         │
  │                          │──INSERT transaction     │
  │                          │  status='pending'──────►│
  │◄──{tx_id,                │                         │
  │    payment_address}──────│                         │
  │                          │                         │
  │  [User sends crypto]     │                         │
  │                          │                         │
  │ (Admin confirms via      │                         │
  │  POST /api/admin/confirm │                         │
  │  {tx_id})───────────────►│                         │
  │                          │──UPDATE transaction     │
  │                          │  status='confirmed'    │
  │                          │──UPDATE users           │
  │                          │  SET balance=bal+500───►│
```

## WebSocket Protocol

### Connection

```
wss://clickmatch-canvas.{namespace}.workers.dev/connect?token={jwt}
```

Server validates JWT on connection upgrade. Refused connections get HTTP 401.

### Message Formats

**Client → Server:**

| Type | Payload | Description |
|------|---------|-------------|
| `click` | `{type:"click", x:int, y:int, color:"#RRGGBB", token:"jwt..."}` | Place a pixel |
| `ping` | `{type:"ping"}` | Keep-alive (every 30s) |
| `sync` | `{type:"sync", last_id:int}` | Request delta events after last known id |

**Server → Client:**

| Type | Payload | Description |
|------|---------|-------------|
| `init` | `{type:"init", expires_at:ISO8601, total_clicks:int}` | Sent on connection; canvas binary sent as separate binary frame |
| `pixel` | `{type:"pixel", id:int, x:int, y:int, color:"#RRGGBB", user_id:"uuid"}` | Broadcast to ALL connected clients |
| `countdown` | `{type:"countdown", seconds_left:int}` | Sent every 60s, plus on connect |
| `frozen` | `{type:"frozen"}` | Competition ended. No more clicks accepted. |
| `error` | `{type:"error", code:int, message:"..."}` | Error response for a specific action |
| `pong` | `{type:"pong"}` | Response to ping |

**Binary Frame (first frame after WS upgrade):** Raw canvas ImageData buffer (1920×1440×4 bytes RGBA), compressed as PNG. The text frame `init` arrives first, then the binary PNG follows.

### Error Codes

| Code | Meaning |
|------|---------|
| 401 | Invalid/expired JWT |
| 402 | Insufficient balance |
| 403 | Canvas is frozen |
| 429 | Rate limited (5 clicks/sec max) |
| 400 | Invalid coordinates or color |

## Durable Object Design

### CanvasRoom (single DO instance)

The `CanvasRoom` Durable Object is the single source of truth for the live canvas state.

**State (in-memory):**
- `canvas`: Uint8ClampedArray(1920×1440×4) — RGBA pixel buffer
- `clients`: Map<WebSocket, {userId, lastClickTs}>
- `eventCount`: global auto-increment counter
- `expiresAt`: ISO8601 timestamp
- `frozen`: boolean

**State (Durable Object Storage):**
- Key `"canvas"`: serialized canvas buffer (stored every 100 clicks + on alarm)
- Key `"eventCount"`: atomic counter

**Lifecycle:**
1. On first request: load canvas from D1 snapshot or initialize white
2. On WebSocket connect: validate JWT, send `init` + binary canvas frame
3. On `click` message:
   - Check `frozen` flag → reject if true
   - Validate x (0-1919), y (0-1439), color (valid hex)
   - Rate limit: max 1 click per 200ms per user
   - Atomic D1: `UPDATE users SET balance=balance-1 WHERE id=? AND balance>0`
   - If rows_affected=0 → send 402 error
   - Insert event row into D1 (get auto-increment id)
   - Update canvas in-memory
   - Broadcast `pixel` to all clients
4. On alarm (every 5 min): persist canvas to D1 snapshot + R2
5. On `frozen`: set flag, persist canvas, broadcast `frozen` to all

### Why Single DO?

For 1920×1440 canvas at Phase 1 scale, a single DO handles the write throughput easily (~1.2 writes/sec average). Durable Objects provide exactly-once processing and strong consistency, which is critical for the "who placed the pixel first" fairness guarantee. If Phase 2 introduces sharded canvas regions, each region becomes its own DO with a coordinating layer.

## HTTP API

All endpoints under `https://api.clickmatch.io/api/`

### Auth

**POST /api/auth/register**
```
Request:  { email: "user@example.com", password: "min8chars" }
Response: { user: { id, email, balance, total_clicks }, token: "jwt..." }
```
- Password hashed with bcrypt (10 rounds)
- JWT signed with HS256, 24h expiry
- Email uniqueness enforced by D1 constraint

**POST /api/auth/login**
```
Request:  { email, password }
Response: { user: { id, email, balance, total_clicks }, token: "jwt..." }
Error:    401 { error: "Invalid credentials" }
```

### User

**GET /api/user/me**
```
Headers:  Authorization: Bearer {jwt}
Response: { id, email, balance, total_clicks, created_at }
```

### Canvas

**GET /api/canvas/state**
```
Response: {
  snapshot_url: "https://r2.../snapshots/latest.png",
  event_id_at: 12458821,
  competition: { phase: 1, ends_at: "2026-07-06T00:00:00Z", status: "active" }
}
```

**GET /api/events?after_id=12458821&limit=500**
```
Headers:  Authorization: Bearer {jwt}
Response: {
  events: [{ id, x, y, color, user_id, timestamp }],
  next_cursor: 12459321
}
```
Cursor-based pagination by event id.

### Competition

**GET /api/competition/current**
```
Response: {
  id: "phase-1",
  phase: 1,
  starts_at: "2026-07-05T00:00:00Z",
  ends_at: "2026-07-06T00:00:00Z",
  status: "active",
  total_clicks: 1045823,
  online_players: 342
}
```

### Top-Up (Manual — Phase 1)

**POST /api/topup/request**
```
Headers:  Authorization: Bearer {jwt}
Request:  { amount_cents: 500 }  // $5.00 = 500 clicks
Response: {
  tx_id: "uuid",
  clicks: 500,
  payment_address: "0x...",  // crypto wallet address
  status: "pending"
}
```

### Leaderboard

**GET /api/leaderboard?limit=50**
```
Response: {
  rankings: [
    { rank: 1, user_id: "uuid", email_preview: "u***@example.com", total_clicks: 42830 },
    ...
  ]
}
```
Combined query across events_live + events_aggregates (see DB schema).

## Security

### JWT Design
- Algorithm: HS256
- Payload: `{ sub: user_id, email, iat, exp }`
- Secret stored in Cloudflare Secrets (`JWT_SECRET`)
- 24h expiry, no refresh tokens in Phase 1

### Rate Limiting
- **Worker level**: 60 requests/min per IP (general API)
- **DO level**: 1 click per 200ms per user (prevents click spamming)
- **Global**: max 1M clicks/day (prevents abuse at canvas level)

### Anti-Abuse
- Click coordinates validated server-side (0-1919, 0-1439)
- Color validated against allowed 16-color palette
- Balance checked atomically (no TOCTOU race)
- Frozen state enforced in DO (reject all clicks)

### CSP Headers
```
Content-Security-Policy: 
  default-src 'self';
  connect-src 'self' wss://*.workers.dev https://api.clickmatch.io;
  img-src 'self' https://r2.clickmatch.io data:;
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'
```

## Deployment

### wrangler.toml structure

```toml
name = "clickmatch"
main = "src/index.ts"
compatibility_date = "2026-07-01"

[[durable_objects.bindings]]
name = "CANVAS_ROOM"
class_name = "CanvasRoom"

[[migrations]]
tag = "v1"
new_classes = ["CanvasRoom"]

[[d1_databases]]
binding = "DB"
database_name = "clickmatch-db"
database_id = "xxx"

[[r2_buckets]]
binding = "ASSETS"
bucket_name = "clickmatch-assets"

[env.production.vars]
JWT_SECRET = ""  # Set via `wrangler secret put JWT_SECRET`
CANVAS_WIDTH = "1920"
CANVAS_HEIGHT = "1440"
```

### DNS
- `clickmatch.io` → Cloudflare Pages (frontend)
- `api.clickmatch.io` → Cloudflare Workers (HTTP API)
- `ws.clickmatch.io` → Durable Objects endpoint (WebSocket)

## Phase 2-4 Extension Points

Architecture designed with extension hooks:

| Extension | Hook Point |
|-----------|-----------|
| **Phase 2: Camp War** | CanvasRoom gains `camps` Map; click validates camp membership; colors restricted by camp |
| **Phase 3: Grayscale** | Color palette override in CanvasRoom; validation restricts to grayscale values |
| **Phase 4: Final Chapter** | Multiple CanvasRoom DOs (sharded by region); coordinator DO for global leaderboard |
| **Payment automation** | Webhook endpoint `POST /api/payment/webhook` replaces manual confirmation |
| **Screenshot/Video** | Cron worker generates PNG from canvas state → R2 → FFmpeg edge function for MP4 |
