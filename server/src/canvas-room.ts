/**
 * ClickMatch — CanvasRoom Durable Object
 *
 * Single source of truth for the live 2560×1600 pixel canvas.
 * Handles WebSocket connections, session-based click validation,
 * atomic balance deduction, event broadcasting, and R2 persistence.
 *
 * v2: Session-based (no auth). session_id in query param + D1 sessions table.
 */

// ── Canvas Dimensions ────────────────────────────────────────
const W = 2560;
const H = 1600;
const CANVAS_BYTES = W * H * 4; // 16,384,000 bytes RGBA

// ── Timing Constants ─────────────────────────────────────────
const RATE_LIMIT_MS = 300;      // Min ms between clicks per session
const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 min between PNG snapshot pushes
const ALARM_INTERVAL_MS = 60 * 1000; // Alarm fires every 60s for countdown + persist check

// ── 80-color Palette (must match frontend COLORS array) ───────
const PALETTE: Set<string> = new Set([
  "#FF0000","#FF3333","#FF5555","#FF7777","#CC0000","#AA0000","#880000","#FF9999",
  "#FF8800","#FFAA00","#FFCC00","#FFDD44","#EE7700","#CC6600","#AA5500","#FFE088",
  "#44FF44","#22DD22","#00CC00","#00AA00","#008800","#006600","#88FF88","#CCFFCC",
  "#00FFCC","#00DDAA","#00CCCC","#00AAAA","#008888","#006666","#88FFDD","#88DDCC",
  "#4488FF","#3366DD","#2244CC","#2222AA","#111188","#000066","#88AAFF","#AACCFF",
  "#8844FF","#7722DD","#6600CC","#5500AA","#440088","#330066","#AA88FF","#CCAAFF",
  "#FF44AA","#FF2288","#FF0066","#DD0055","#CC0044","#AA0033","#FF88CC","#FFAADD",
  "#886644","#AA7744","#CC9955","#DAA520","#C8961E","#B8860B","#FFCC88","#FFDDAA",
  "#000000","#333333","#555555","#777777","#999999","#BBBBBB","#DDDDDD","#FFFFFF",
  "#8B4513","#CD853F","#DEB887","#F5DEB3","#D2691E","#A0522D","#BC8F8F","#FFE4C4"
]);

// ── DO Storage Keys ─────────────────────────────────────────
const KEY_CANVAS      = "canvas";
const KEY_EVENT_COUNT = "eventCount";
const KEY_PERSIST_AT  = "lastPersistTime";

// ── Types ────────────────────────────────────────────────────
interface Env {
  CANVAS_ROOM: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: R2Bucket;
}

interface ClickMessage { type: "click"; x: number; y: number; color: string; }
interface PingMessage   { type: "ping"; }
type ClientMessage = ClickMessage | PingMessage;

interface InitMessage    { type: "init";    event_count: number; connected: number; }
interface PixelMessage   { type: "pixel";   id: number; x: number; y: number; color: string; sid: string; }
interface CountdownMsg   { type: "countdown"; seconds: number; }
interface ErrorMessage   { type: "error";   code: number; message: string; }
type ServerMessage = InitMessage | PixelMessage | CountdownMsg | ErrorMessage;

// ── Helpers ──────────────────────────────────────────────────

function hexToRGBA(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ── CRC32 for PNG chunks ────────────────────────────────────
const CRC32_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(d: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (const b of d) c = (c >>> 8) ^ CRC32_TABLE[(c ^ b) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  new DataView(out.buffer).setUint32(0, len, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + len);
  crcData.set(out.subarray(4, 8), 0);
  crcData.set(data, 4);
  new DataView(out.buffer).setUint32(8 + len, crc32(crcData), false);
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter();
  const r = cs.readable.getReader();
  w.write(data); w.close();
  const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function encodePNG(w: number, h: number, rgba: Uint8Array): Promise<Uint8Array> {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w, false); v.setUint32(4, h, false);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const ihdrC = pngChunk("IHDR", ihdr);
  // Filtered + deflated pixel data
  const rowBytes = w * 4;
  const filt = new Uint8Array(h * (1 + rowBytes));
  for (let y = 0; y < h; y++) {
    const bo = y * (1 + rowBytes);
    filt[bo] = 0; // filter None
    const so = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) filt[bo + 1 + i] = rgba[so + i];
  }
  const compressed = await deflate(filt);
  const idatC = pngChunk("IDAT", compressed);
  const iendC = pngChunk("IEND", new Uint8Array(0));
  const all = [sig, ihdrC, idatC, iendC];
  const total = all.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of all) { out.set(c, off); off += c.length; }
  return out;
}

// ── CanvasRoom ───────────────────────────────────────────────

export class CanvasRoom extends DurableObject {
  private canvas: Uint8ClampedArray;
  private eventCount = 0;
  private lastPersistTime = 0;
  private lastClick: Map<string, number> = new Map(); // sessionId → timestamp
  private initialized = false;
  private cachedPNG: Uint8Array | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.canvas = new Uint8ClampedArray(CANVAS_BYTES);
  }

  // ── HTTP Entry ────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    await this.ensureInit();
    const url = new URL(req.url);

    if (url.pathname === "/connect" || url.pathname.endsWith("/connect")) {
      return this.wsUpgrade(req);
    }

    return new Response(JSON.stringify({
      event_count: this.eventCount,
      connected: this.ctx.getWebSockets().length,
    }), { headers: { "Content-Type": "application/json" } });
  }

  // ── Init ──────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    const saved = await this.ctx.storage.get(KEY_CANVAS);
    if (saved && saved instanceof ArrayBuffer) {
      this.canvas = new Uint8ClampedArray(saved);
    } else {
      this.canvas.fill(255); // white
    }
    this.eventCount = (await this.ctx.storage.get(KEY_EVENT_COUNT) as number) || 0;
    this.lastPersistTime = (await this.ctx.storage.get(KEY_PERSIST_AT) as number) || Date.now();
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    this.initialized = true;
    console.log(`[CanvasRoom] Init. events=${this.eventCount}`);
  }

  // ── Alarm ─────────────────────────────────────────────────

  async alarm(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPersistTime >= PERSIST_INTERVAL_MS) {
      await this.persist();
      this.lastPersistTime = now;
      await this.ctx.storage.put(KEY_PERSIST_AT, now);
    }
    // Countdown broadcast
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      this.sendToAll({ type: "countdown", seconds: Math.max(0, Math.floor((this.lastPersistTime + PERSIST_INTERVAL_MS - now) / 1000)) });
    }
    await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  // ── WebSocket Upgrade ─────────────────────────────────────

  private async wsUpgrade(req: Request): Promise<Response> {
    const sessionId = new URL(req.url).searchParams.get("session_id");
    if (!sessionId) return new Response("Missing session_id", { status: 401 });

    // Ensure session exists in D1
    try {
      await this.env.DB.prepare(
        `INSERT INTO sessions (session_id, clicks) VALUES (?, 0)
         ON CONFLICT(session_id) DO NOTHING`
      ).bind(sessionId).run();
    } catch (e) {
      console.error("[CanvasRoom] Session create failed:", e);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [sessionId]);

    // Send init
    this.sendOne(server, {
      type: "init",
      event_count: this.eventCount,
      connected: this.ctx.getWebSockets().length,
    });

    // Send canvas PNG as binary
    try {
      server.send(await this.getPNG());
    } catch (e) {
      console.error("[CanvasRoom] PNG send failed:", e);
    }

    console.log(`[CanvasRoom] Connected. sid=${sessionId}, total=${this.ctx.getWebSockets().length}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Message Handler ───────────────────────────────────────

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "ping") {
      this.sendOne(ws, { type: "init", event_count: this.eventCount, connected: this.ctx.getWebSockets().length } as InitMessage);
      return;
    }

    if (msg.type === "click") {
      await this.handleClick(ws, msg);
    }
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    console.log(`[CanvasRoom] Disconnect. remaining=${this.ctx.getWebSockets().length}`);
  }

  async webSocketError(_ws: WebSocket, e: unknown): Promise<void> {
    console.error("[CanvasRoom] WS error:", e);
  }

  // ── Click ─────────────────────────────────────────────────

  private async handleClick(ws: WebSocket, msg: ClickMessage): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const sid = tags[0];
    if (!sid) return;

    // Validate coords
    if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y) || msg.x < 0 || msg.x >= W || msg.y < 0 || msg.y >= H) {
      this.sendOne(ws, { type: "error", code: 400, message: "Invalid coords" });
      return;
    }

    // Validate color
    const color = msg.color ? msg.color.toUpperCase() : "";
    if (!PALETTE.has(color)) {
      this.sendOne(ws, { type: "error", code: 400, message: "Invalid color" });
      return;
    }

    // Rate limit
    const now = Date.now();
    const last = this.lastClick.get(sid) || 0;
    if (now - last < RATE_LIMIT_MS) {
      this.sendOne(ws, { type: "error", code: 429, message: "Rate limited" });
      return;
    }

    // Atomic deduct from sessions
    try {
      const result = await this.env.DB.prepare(
        `UPDATE sessions SET clicks = clicks - 1, updated_at = datetime("now")
         WHERE session_id = ? AND clicks > 0`
      ).bind(sid).run();

      if (!result.meta.changes || result.meta.changes === 0) {
        this.sendOne(ws, { type: "error", code: 402, message: "No clicks" });
        return;
      }
    } catch (e) {
      console.error("[CanvasRoom] Deduct failed:", e);
      this.sendOne(ws, { type: "error", code: 500, message: "Server error" });
      return;
    }

    this.lastClick.set(sid, now);
    this.eventCount++;

    // Paint
    const [r, g, b] = hexToRGBA(color);
    const idx = (msg.y * W + msg.x) * 4;
    this.canvas[idx] = r; this.canvas[idx + 1] = g; this.canvas[idx + 2] = b; this.canvas[idx + 3] = 255;
    this.cachedPNG = null;

    // Broadcast
    this.sendToAll({ type: "pixel", id: this.eventCount, x: msg.x, y: msg.y, color, sid });

    // Persist counter (lightweight, every click)
    await this.ctx.storage.put(KEY_EVENT_COUNT, this.eventCount);
  }

  // ── Canvas PNG ────────────────────────────────────────────

  private async getPNG(): Promise<Uint8Array> {
    if (!this.cachedPNG) this.cachedPNG = await encodePNG(W, H, this.canvas);
    return this.cachedPNG;
  }

  // ── Persist to R2 + D1 ────────────────────────────────────

  private async persist(): Promise<void> {
    const png = await this.getPNG();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
    const key = `snapshots/${ts}.png`;

    try {
      await this.env.ASSETS.put(key, png.buffer, { httpMetadata: { contentType: "image/png" } });
      await this.env.DB.prepare(
        `INSERT INTO canvas_snapshots (id, r2_key, event_id_at, size_bytes) VALUES (?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), key, this.eventCount, png.length).run();
      console.log(`[CanvasRoom] Snapshot: ${key} (${png.length}B)`);
    } catch (e) {
      console.error("[CanvasRoom] Persist error:", e);
    }

    // Save to DO storage for cold-start recovery
    await this.ctx.storage.put(KEY_CANVAS, this.canvas.buffer);
    await this.ctx.storage.put(KEY_EVENT_COUNT, this.eventCount);
    await this.ctx.storage.put(KEY_PERSIST_AT, this.lastPersistTime);
  }

  // ── Senders ───────────────────────────────────────────────

  private sendToAll(msg: ServerMessage): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }

  private sendOne(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}
