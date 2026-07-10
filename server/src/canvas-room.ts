/**
 * ClickMatch — CanvasRoom Durable Object
 *
 * Single source of truth for the live 1920×1440 pixel canvas.
 * Handles WebSocket connections, click validation, atomic balance
 * deduction, event logging, and canvas persistence.
 *
 * Phase 1: Global free-for-all pixel competition, single DO instance.
 */

// ── Constants ────────────────────────────────────────────────

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1440;
const CANVAS_SIZE = CANVAS_WIDTH * CANVAS_HEIGHT * 4; // RGBA bytes
const ALARM_INTERVAL_MS = 5 * 60 * 1000; // Persist every 5 minutes
const COUNTDOWN_INTERVAL_MS = 60 * 1000; // Alarm fires every 60s for countdown
const RATE_LIMIT_MS = 200; // Per-user click rate limit in ms

/** 16-color palette — validated against every color in click messages */
const PALETTE: Set<string> = new Set([
  '#FF4444', '#FF8800', '#FFCC00', '#44CC44',
  '#00CCCC', '#4488FF', '#8844CC', '#FF66AA',
  '#FFFFFF', '#CCCCCC', '#888888', '#444444',
  '#000000', '#886644', '#DAA520', '#88CCFF',
]);

// ── DO Storage Keys ─────────────────────────────────────────

const STORAGE_KEY_CANVAS = 'canvas';
const STORAGE_KEY_EVENT_COUNT = 'eventCount';
const STORAGE_KEY_EXPIRES_AT = 'expiresAt';
const STORAGE_KEY_FROZEN = 'frozen';
const STORAGE_KEY_LAST_PERSIST = 'lastPersistTime';

// ── Types ────────────────────────────────────────────────────

interface Env {
  CANVAS_ROOM: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: R2Bucket;
  JWT_SECRET: string;
}

interface ClickMessage {
  type: 'click';
  x: number;
  y: number;
  color: string;
  token: string;
}

interface PingMessage {
  type: 'ping';
}

interface SyncMessage {
  type: 'sync';
  last_id: number;
}

type ClientMessage = ClickMessage | PingMessage | SyncMessage;

interface InitPayload {
  type: 'init';
  expires_at: string;
  total_clicks: number;
}

interface PixelPayload {
  type: 'pixel';
  id: number;
  x: number;
  y: number;
  color: string;
  user_id: string;
}

interface CountdownPayload {
  type: 'countdown';
  seconds_left: number;
}

interface ErrorPayload {
  type: 'error';
  code: number;
  message: string;
}

type ServerMessage = InitPayload | PixelPayload | CountdownPayload | ErrorPayload | { type: 'frozen' } | { type: 'pong' };

interface JWTPayload {
  sub: string;   // user_id
  email: string;
  iat: number;
  exp: number;
}

// ── CRC32 ────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG Encoder ──────────────────────────────────────────────
//
// Produces a valid PNG from raw RGBA pixel data using
// CompressionStream('deflate') for zlib-wrapped DEFLATE (RFC 1950).
// No external dependencies — runs entirely in Workers runtime.

function makePNGChunk(type: string, data: Uint8Array): Uint8Array {
  const length = data.length;
  const chunk = new Uint8Array(12 + length); // 4(len) + 4(type) + data + 4(crc)
  const view = new DataView(chunk.buffer);
  view.setUint32(0, length, false); // big-endian

  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }

  chunk.set(data, 8);

  const typeAndData = new Uint8Array(4 + length);
  typeAndData.set(chunk.subarray(4, 8), 0);
  typeAndData.set(data, 4);
  view.setUint32(8 + length, crc32(typeAndData), false);

  return chunk;
}

async function compressDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  writer.write(data);
  writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalSize = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Encode raw RGBA pixel data as a PNG image.
 * Uses filter type 0 (None) per scanline.
 * Returns the complete PNG as a Uint8Array.
 */
async function encodePNG(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  // 1. PNG signature
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // 2. IHDR chunk (13 bytes)
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type: RGBA
  ihdrData[10] = 0;  // compression method: deflate
  ihdrData[11] = 0;  // filter method: adaptive
  ihdrData[12] = 0;  // interlace: none
  const ihdrChunk = makePNGChunk('IHDR', ihdrData);

  // 3. IDAT chunk — filtered + deflate-compressed pixel data
  //    Each scanline: 1-byte filter (0=Sub/None) + row pixels
  const rowBytes = width * 4;
  const filtered = new Uint8Array(height * (1 + rowBytes));
  for (let row = 0; row < height; row++) {
    const outOff = row * (1 + rowBytes);
    filtered[outOff] = 0; // filter: None
    const srcOff = row * rowBytes;
    // Manual copy to avoid set() issues with overlapping ranges
    for (let i = 0; i < rowBytes; i++) {
      filtered[outOff + 1 + i] = rgba[srcOff + i];
    }
  }

  const compressed = await compressDeflate(filtered);
  const idatChunk = makePNGChunk('IDAT', compressed);

  // 4. IEND chunk (empty)
  const iendChunk = makePNGChunk('IEND', new Uint8Array(0));

  // 5. Assemble
  const totalSize = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const result = new Uint8Array(totalSize);
  let offset = 0;
  result.set(signature, offset); offset += signature.length;
  result.set(ihdrChunk, offset); offset += ihdrChunk.length;
  result.set(idatChunk, offset); offset += idatChunk.length;
  result.set(iendChunk, offset);

  return result;
}

// ── JWT Verification ────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlDecode(input: string): Uint8Array {
  // Replace URL-safe chars and add padding
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad) base64 += '='.repeat(4 - pad);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlDecode(signatureB64);

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['verify']
    );

    const valid = await crypto.subtle.verify('HMAC', key, signature, signingInput);
    if (!valid) return null;

    const payloadBytes = base64UrlDecode(payloadB64);
    const payload = JSON.parse(decoder.decode(payloadBytes)) as JWTPayload;

    // Check expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function hexToRGBA(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function getEventsTableName(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `events_${year}_${month}`;
}

// ── CanvasRoom Durable Object ────────────────────────────────

export class CanvasRoom extends DurableObject {
  /** RGBA pixel buffer (1920 × 1440 × 4 = 11,059,200 bytes) */
  private canvas: Uint8ClampedArray;

  /** Global auto-increment event counter (≈ last event id) */
  private eventCount: number = 0;

  /** Competition end time (ISO8601) */
  private expiresAt: string = '';

  /** Whether the competition has ended and canvas is frozen */
  private frozen: boolean = false;

  /** Timestamp (ms) of last D1+R2 persistence */
  private lastPersistTime: number = 0;

  /** Per-user rate limiting: userId → lastClickTimestamp(ms) */
  private userLastClick: Map<string, number> = new Map();

  /** Whether state has been loaded from DO storage */
  private initialized: boolean = false;

  /** Cached PNG for the current canvas state (invalidated on pixel writes) */
  private cachedPNG: Uint8Array | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.canvas = new Uint8ClampedArray(CANVAS_SIZE);
  }

  // ── Lifecycle: HTTP Fetch ──────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();

    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        frozen: this.frozen,
        expires_at: this.expiresAt,
        event_count: this.eventCount,
        connected_clients: this.ctx.getWebSockets().length,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // ── Lifecycle: Alarm ───────────────────────────────────────

  async alarm(): Promise<void> {
    const now = Date.now();

    // Check if competition has ended
    if (this.expiresAt && !this.frozen) {
      const expiresMs = new Date(this.expiresAt).getTime();
      if (now >= expiresMs) {
        this.frozen = true;
        await this.persistDOState();
        await this.persistToD1R2();
        this.broadcast({ type: 'frozen' });
        return; // No more alarms after frozen
      }

      // Send countdown to all clients
      const secondsLeft = Math.max(0, Math.floor((expiresMs - now) / 1000));
      this.broadcast({ type: 'countdown', seconds_left: secondsLeft });
    }

    // Persist every ALARM_INTERVAL_MS
    if (now - this.lastPersistTime >= ALARM_INTERVAL_MS) {
      await this.persistToD1R2();
      this.lastPersistTime = now;
      await this.ctx.storage.put(STORAGE_KEY_LAST_PERSIST, this.lastPersistTime);
    }

    // Set next alarm
    if (!this.frozen) {
      await this.ctx.storage.setAlarm(now + COUNTDOWN_INTERVAL_MS);
    }
  }

  // ── WebSocket Message Handler ──────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Ignore binary messages from client
    if (typeof message !== 'string') return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      this.sendError(ws, 400, 'Invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'click':
        await this.handleClick(ws, msg);
        break;
      case 'ping':
        this.sendTo(ws, { type: 'pong' });
        break;
      case 'sync':
        // Delta sync not implemented in WebSocket — use HTTP /api/events endpoint
        break;
      default:
        this.sendError(ws, 400, `Unknown message type: ${(msg as any).type}`);
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // DO automatically removes the WebSocket from getWebSockets()
    // No explicit cleanup needed — rate-limit map entries are ephemeral
    console.log(`[CanvasRoom] Client disconnected, remaining: ${this.ctx.getWebSockets().length}`);
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('[CanvasRoom] WebSocket error:', error);
  }

  // ── State Initialization ───────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Load canvas from DO storage
    const savedCanvas = await this.ctx.storage.get(STORAGE_KEY_CANVAS);
    if (savedCanvas && savedCanvas instanceof ArrayBuffer) {
      this.canvas = new Uint8ClampedArray(savedCanvas);
    } else {
      // Initialize all-white canvas (RGBA: 255,255,255,255)
      this.canvas = new Uint8ClampedArray(CANVAS_SIZE);
      this.canvas.fill(255);
    }

    // Load counters
    this.eventCount = (await this.ctx.storage.get(STORAGE_KEY_EVENT_COUNT) as number) || 0;
    this.expiresAt = (await this.ctx.storage.get(STORAGE_KEY_EXPIRES_AT) as string) || '';
    this.frozen = (await this.ctx.storage.get(STORAGE_KEY_FROZEN) as boolean) || false;
    this.lastPersistTime = (await this.ctx.storage.get(STORAGE_KEY_LAST_PERSIST) as number) || Date.now();

    // If no expiresAt, load from D1 competitions table
    if (!this.expiresAt) {
      try {
        const comp = await this.env.DB.prepare(
          `SELECT ends_at FROM competitions WHERE status = 'active' ORDER BY starts_at DESC LIMIT 1`
        ).first<{ ends_at: string }>();
        if (comp && comp.ends_at) {
          this.expiresAt = comp.ends_at;
          await this.ctx.storage.put(STORAGE_KEY_EXPIRES_AT, this.expiresAt);
        }
      } catch (err) {
        console.error('[CanvasRoom] Failed to load competition from D1:', err);
      }
    }

    // Check if competition should already be frozen
    if (this.expiresAt && !this.frozen) {
      const expiresMs = new Date(this.expiresAt).getTime();
      if (Date.now() >= expiresMs) {
        this.frozen = true;
        await this.ctx.storage.put(STORAGE_KEY_FROZEN, true);
      }
    }

    // Start alarm loop if not frozen
    if (!this.frozen) {
      await this.ctx.storage.setAlarm(Date.now() + COUNTDOWN_INTERVAL_MS);
    }

    this.initialized = true;
    console.log(`[CanvasRoom] Initialized. eventCount=${this.eventCount} frozen=${this.frozen}`);
  }

  // ── WebSocket Upgrade ──────────────────────────────────────

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return new Response('Missing token parameter', { status: 401 });
    }

    const payload = await verifyJWT(token, this.env.JWT_SECRET);
    if (!payload) {
      return new Response('Invalid or expired token', { status: 401 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept server-side WebSocket with user ID tag
    this.ctx.acceptWebSocket(server, [payload.sub]);

    // Send init message (text frame)
    this.sendTo(server, {
      type: 'init',
      expires_at: this.expiresAt,
      total_clicks: this.eventCount,
    });

    // Send canvas as binary PNG frame
    try {
      const png = await this.getCanvasPNG();
      server.send(png);
    } catch (err) {
      console.error('[CanvasRoom] Failed to send canvas PNG:', err);
    }

    // If frozen, also send frozen notification
    if (this.frozen) {
      this.sendTo(server, { type: 'frozen' });
    }

    console.log(`[CanvasRoom] Client connected (user=${payload.sub}), total clients: ${this.ctx.getWebSockets().length}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Click Handling ─────────────────────────────────────────

  private async handleClick(ws: WebSocket, msg: ClickMessage): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const userId = tags[0];

    if (!userId) {
      this.sendError(ws, 401, 'Not authenticated');
      return;
    }

    // 1. Check frozen
    if (this.frozen) {
      this.sendError(ws, 403, 'Canvas is frozen');
      return;
    }

    // 2. Validate coordinates
    if (
      typeof msg.x !== 'number' || typeof msg.y !== 'number' ||
      !Number.isInteger(msg.x) || !Number.isInteger(msg.y) ||
      msg.x < 0 || msg.x >= CANVAS_WIDTH ||
      msg.y < 0 || msg.y >= CANVAS_HEIGHT
    ) {
      this.sendError(ws, 400, 'Invalid coordinates');
      return;
    }

    // 3. Validate color against 16-color palette
    const color = typeof msg.color === 'string' ? msg.color.toUpperCase() : '';
    if (!PALETTE.has(color)) {
      this.sendError(ws, 400, 'Invalid color — must be one of the 16 palette colors');
      return;
    }

    // 4. Rate limit: 1 click per RATE_LIMIT_MS ms per user
    const now = Date.now();
    const lastClick = this.userLastClick.get(userId) || 0;
    if (now - lastClick < RATE_LIMIT_MS) {
      this.sendError(ws, 429, `Rate limited — max 1 click per ${RATE_LIMIT_MS}ms`);
      return;
    }

    // 5. Atomic balance check in D1
    try {
      const { meta } = await this.env.DB.prepare(
        `UPDATE users SET balance = balance - 1, total_clicks = total_clicks + 1
         WHERE id = ? AND balance > 0`
      ).bind(userId).run();

      if (!meta.changes || meta.changes === 0) {
        this.sendError(ws, 402, 'Insufficient balance — please top up');
        return;
      }
    } catch (err) {
      console.error('[CanvasRoom] D1 balance update failed:', err);
      this.sendError(ws, 500, 'Internal server error — please try again');
      return;
    }

    // Record click timestamp AFTER balance deduct succeeds
    this.userLastClick.set(userId, now);

    // 6. Insert event row into D1
    let eventId: number;
    try {
      const tableName = getEventsTableName();
      const { meta: insertMeta } = await this.env.DB.prepare(
        `INSERT INTO ${tableName} (x, y, color, user_id) VALUES (?, ?, ?, ?)`
      ).bind(msg.x, msg.y, color, userId).run();

      eventId = insertMeta.last_row_id ?? (this.eventCount + 1);
      this.eventCount = eventId;
    } catch (err) {
      console.error('[CanvasRoom] D1 event insert failed:', err);
      // Balance was already deducted — this is an inconsistency.
      // For Phase 1, we accept this edge case. The user loses a click but
      // no pixel is placed. A reconciliation job can handle this later.
      this.sendError(ws, 500, 'Failed to record event — click balance was consumed');
      return;
    }

    // 7. Update in-memory canvas
    const [r, g, b] = hexToRGBA(color);
    const pixelIndex = (msg.y * CANVAS_WIDTH + msg.x) * 4;
    this.canvas[pixelIndex] = r;
    this.canvas[pixelIndex + 1] = g;
    this.canvas[pixelIndex + 2] = b;
    this.canvas[pixelIndex + 3] = 255;

    // Invalidate PNG cache
    this.cachedPNG = null;

    // 8. Broadcast pixel to ALL connected clients
    this.broadcast({
      type: 'pixel',
      id: eventId,
      x: msg.x,
      y: msg.y,
      color: color,
      user_id: userId,
    });

    // 9. Persist eventCount to DO storage (every click, cheap write)
    await this.ctx.storage.put(STORAGE_KEY_EVENT_COUNT, this.eventCount);
  }

  // ── Canvas PNG ─────────────────────────────────────────────

  private async getCanvasPNG(): Promise<Uint8Array> {
    if (this.cachedPNG) return this.cachedPNG;
    this.cachedPNG = await encodePNG(CANVAS_WIDTH, CANVAS_HEIGHT, this.canvas);
    return this.cachedPNG;
  }

  // ── Persistence ────────────────────────────────────────────

  /** Persist volatile state to DO storage (lightweight, for DO restarts) */
  private async persistDOState(): Promise<void> {
    await Promise.all([
      this.ctx.storage.put(STORAGE_KEY_CANVAS, this.canvas.buffer),
      this.ctx.storage.put(STORAGE_KEY_EVENT_COUNT, this.eventCount),
      this.ctx.storage.put(STORAGE_KEY_EXPIRES_AT, this.expiresAt),
      this.ctx.storage.put(STORAGE_KEY_FROZEN, this.frozen),
      this.ctx.storage.put(STORAGE_KEY_LAST_PERSIST, this.lastPersistTime),
    ]);
  }

  /** Generate PNG snapshot, upload to R2, record in D1 */
  private async persistToD1R2(): Promise<void> {
    const png = await this.getCanvasPNG();

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
    const r2Key = `snapshots/${timestamp}.png`;

    try {
      // Upload to R2
      await this.env.ASSETS.put(r2Key, png.buffer, {
        httpMetadata: { contentType: 'image/png' },
      });

      // Record in D1
      const snapshotId = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO canvas_snapshots (id, r2_key, event_id_at, size_bytes)
         VALUES (?, ?, ?, ?)`
      ).bind(snapshotId, r2Key, this.eventCount, png.length).run();

      console.log(`[CanvasRoom] Snapshot persisted: ${r2Key} (${png.length} bytes, event_id=${this.eventCount})`);
    } catch (err) {
      console.error('[CanvasRoom] Snapshot persist failed:', err);
    }

    // Always persist DO-local state regardless of R2 success
    await this.persistDOState();
  }

  // ── Messaging Helpers ──────────────────────────────────────

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        // WebSocket may be closing/closed — DO will clean up
      }
    }
  }

  private sendTo(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // WebSocket may be closing
    }
  }

  private sendError(ws: WebSocket, code: number, message: string): void {
    this.sendTo(ws, { type: 'error', code, message });
  }
}
