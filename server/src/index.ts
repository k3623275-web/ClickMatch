// ClickMatch Worker HTTP API Entry Point
// Cloudflare Workers — handles auth, top-up, canvas state, events, competition, leaderboard,
// and routes WebSocket connections to the CanvasRoom Durable Object.

import { authenticateRequest, hashPassword, verifyPassword, createToken } from './auth';

export { CanvasRoom } from './canvas-room'; // Required for DO binding
import { DB } from './db';
import {
  validateEmail,
  validatePassword,
  validateAmountCents,
  validateLimit,
  validateAfterId,
} from './validation';
import { Env, ErrorResponse, UserPublic } from './types';

// CORS headers applied to all responses
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Strip private fields from a User to return UserPublic.
 */
function toPublicUser(user: {
  id: string;
  email: string;
  balance: number;
  total_clicks: number;
  created_at: string;
}): UserPublic {
  return {
    id: user.id,
    email: user.email,
    balance: user.balance,
    total_clicks: user.total_clicks,
    created_at: user.created_at,
  };
}

/**
 * Create a JSON response with CORS headers.
 */
function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

/**
 * Create an error JSON response.
 */
function error(message: string, status: number = 400): Response {
  const body: ErrorResponse = { error: message };
  if (status) body.code = status;
  return json(body, status);
}

// ===================== Main Fetch Handler =====================

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const db = new DB(env.DB);

    try {
      // ===================== Auth Routes =====================

      if (path === '/api/auth/register' && method === 'POST') {
        return handleRegister(request, db, env);
      }

      if (path === '/api/auth/login' && method === 'POST') {
        return handleLogin(request, db, env);
      }

      // ===================== User Routes =====================

      if (path === '/api/user/me' && method === 'GET') {
        return handleUserMe(request, db, env);
      }

      // ===================== Top-Up Routes =====================

      if (path === '/api/topup/request' && method === 'POST') {
        return handleTopUp(request, db, env);
      }

      // ===================== Canvas Routes =====================

      if (path === '/api/canvas/state' && method === 'GET') {
        return handleCanvasState(db, env);
      }

      // ===================== Events Routes =====================

      if (path === '/api/events' && method === 'GET') {
        return handleEvents(request, db, env);
      }

      // ===================== Competition Routes =====================

      if (path === '/api/competition/current' && method === 'GET') {
        return handleCompetitionCurrent(db, env);
      }

      // ===================== Leaderboard Routes =====================

      if (path === '/api/leaderboard' && method === 'GET') {
        return handleLeaderboard(request, db);
      }

      // ===================== WebSocket =====================

      if (path === '/api/canvas/connect' && method === 'GET') {
        // Delegate WebSocket upgrade to CanvasRoom DO
        const id = env.CANVAS_ROOM.idFromName('canvas-room');
        const stub = env.CANVAS_ROOM.get(id);
        return stub.fetch(request);
      }

      // ===================== 404 =====================

      return error('Not found', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return error('Internal server error', 500);
    }
  },
};

// ===================== Route Handlers =====================

/**
 * POST /api/auth/register
 *
 * Request:  { email: string, password: string }
 * Response: { user: UserPublic, token: string }
 */
async function handleRegister(
  request: Request,
  db: DB,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }

  const { email, password } = body as Record<string, unknown>;

  // Validate input
  const emailCheck = validateEmail(email);
  if (!emailCheck.valid) return error(emailCheck.error!, 400);

  const passCheck = validatePassword(password);
  if (!passCheck.valid) return error(passCheck.error!, 400);

  // Check if email already exists
  const existing = await db.getUserByEmail(email as string);
  if (existing) {
    return error('Email already registered', 409);
  }

  // Hash password and create user
  const hashed = await hashPassword(password as string);
  const user = await db.createUser(email as string, hashed);

  // Create JWT
  const token = await createToken(
    { sub: user.id, email: user.email },
    env.JWT_SECRET,
  );

  return json({
    user: toPublicUser(user),
    token,
  });
}

/**
 * POST /api/auth/login
 *
 * Request:  { email: string, password: string }
 * Response: { user: UserPublic, token: string }
 * Error:    401 { error: "Invalid credentials" }
 */
async function handleLogin(
  request: Request,
  db: DB,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }

  const { email, password } = body as Record<string, unknown>;

  if (typeof email !== 'string' || typeof password !== 'string') {
    return error('Email and password are required', 400);
  }

  // Look up user by email
  const user = await db.getUserByEmail(email);
  if (!user) {
    return error('Invalid credentials', 401);
  }

  // Verify password
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return error('Invalid credentials', 401);
  }

  // Create JWT
  const token = await createToken(
    { sub: user.id, email: user.email },
    env.JWT_SECRET,
  );

  return json({
    user: toPublicUser(user),
    token,
  });
}

/**
 * GET /api/user/me
 *
 * Headers:  Authorization: Bearer {jwt}
 * Response: { id, email, balance, total_clicks, created_at }
 */
async function handleUserMe(
  request: Request,
  db: DB,
  env: Env,
): Promise<Response> {
  const jwt = await authenticateRequest(request, env.JWT_SECRET);
  if (!jwt) {
    return error('Unauthorized', 401);
  }

  const user = await db.getUserById(jwt.sub);
  if (!user) {
    return error('User not found', 404);
  }

  return json(toPublicUser(user));
}

/**
 * POST /api/topup/request
 *
 * Headers:  Authorization: Bearer {jwt}
 * Request:  { amount_cents: number }
 * Response: { tx_id, clicks, payment_address, status }
 */
async function handleTopUp(
  request: Request,
  db: DB,
  env: Env,
): Promise<Response> {
  const jwt = await authenticateRequest(request, env.JWT_SECRET);
  if (!jwt) {
    return error('Unauthorized', 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }

  const { amount_cents } = body as Record<string, unknown>;

  const amountCheck = validateAmountCents(amount_cents);
  if (!amountCheck.valid) return error(amountCheck.error!, 400);

  const amount = amount_cents as number;

  // $0.01 per click: amount in cents = number of clicks
  const clicksPurchased = amount;

  const transaction = await db.createTransaction(
    jwt.sub,
    amount,
    clicksPurchased,
  );

  const paymentAddress = env.PAYMENT_ADDRESS || 'PAYMENT_ADDRESS_NOT_CONFIGURED';

  return json({
    tx_id: transaction.id,
    clicks: clicksPurchased,
    payment_address: paymentAddress,
    status: transaction.status,
  });
}

/**
 * GET /api/canvas/state
 *
 * Response: { snapshot_url, event_id_at, competition }
 *
 * Returns the latest canvas snapshot R2 URL + the event_id_at cursor
 * so clients can stream delta events from that point.
 */
async function handleCanvasState(db: DB, env: Env): Promise<Response> {
  const snapshot = await db.getLatestSnapshot();
  const competition = await db.getCurrentCompetition();

  // Build snapshot URL from R2 key if available
  let snapshotUrl: string | null = null;
  let eventIdAt = 0;

  if (snapshot) {
    // Construct a public R2 URL. In production this would use a custom domain
    // or a signed URL. Phase 1 uses the public R2.dev domain.
    // The r2_key format is like "snapshots/2026-07-05T1730Z.png"
    // R2 public access: https://{accountid}.r2.cloudflarestorage.com/{bucket}/{key}
    snapshotUrl = `https://clickmatch-assets.r2.cloudflarestorage.com/${snapshot.r2_key}`;
    eventIdAt = snapshot.event_id_at;
  }

  return json({
    snapshot_url: snapshotUrl,
    event_id_at: eventIdAt,
    competition: competition
      ? {
          phase: competition.phase,
          ends_at: competition.ends_at,
          status: competition.status,
        }
      : null,
  });
}

/**
 * GET /api/events?after_id=0&limit=500
 *
 * Headers:  Authorization: Bearer {jwt}
 * Response: { events: Event[], next_cursor: number | null }
 *
 * Cursor-based pagination by event id. Client tracks the last id received.
 */
async function handleEvents(
  request: Request,
  db: DB,
  env: Env,
): Promise<Response> {
  const jwt = await authenticateRequest(request, env.JWT_SECRET);
  if (!jwt) {
    return error('Unauthorized', 401);
  }

  const url = new URL(request.url);
  const afterIdRaw = url.searchParams.get('after_id');
  const limitRaw = url.searchParams.get('limit');

  // Validate after_id
  const afterIdCheck = validateAfterId(
    afterIdRaw !== null ? afterIdRaw : undefined,
  );
  if (!afterIdCheck.valid) return error(afterIdCheck.error!, 400);

  // Validate limit (max 1000 for events)
  const limitCheck = validateLimit(
    limitRaw !== null ? limitRaw : '500',
    1000,
  );
  if (!limitCheck.valid) return error(limitCheck.error!, 400);

  const afterId = afterIdRaw ? parseInt(afterIdRaw, 10) : 0;
  const limit = limitRaw ? parseInt(limitRaw, 10) : 500;

  const { events, nextCursor } = await db.getEvents(afterId, limit);

  return json({ events, next_cursor: nextCursor });
}

/**
 * GET /api/competition/current
 *
 * Response: { id, phase, starts_at, ends_at, status, total_clicks, online_players }
 */
async function handleCompetitionCurrent(db: DB, env: Env): Promise<Response> {
  const competition = await db.getCurrentCompetition();

  if (!competition) {
    return json({
      id: null,
      phase: 1,
      starts_at: null,
      ends_at: null,
      status: 'no_competition',
      total_clicks: 0,
      online_players: 0,
    });
  }

  const [totalClicks, onlinePlayers] = await Promise.all([
    db.getTotalClicks(),
    db.getOnlinePlayerCount(),
  ]);

  return json({
    id: competition.id,
    phase: competition.phase,
    starts_at: competition.starts_at,
    ends_at: competition.ends_at,
    status: competition.status,
    total_clicks: totalClicks,
    online_players: onlinePlayers,
  });
}

/**
 * GET /api/leaderboard?limit=50
 *
 * Response: { rankings: [{ rank, user_id, email_preview, total_clicks }] }
 */
async function handleLeaderboard(
  request: Request,
  db: DB,
): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get('limit');

  // Validate limit (max 100 for leaderboard)
  const limitCheck = validateLimit(
    limitRaw !== null ? limitRaw : '50',
    100,
  );
  if (!limitCheck.valid) return error(limitCheck.error!, 400);

  const limit = limitRaw ? parseInt(limitRaw, 10) : 50;

  const rankings = await db.getLeaderboard(limit);

  return json({ rankings });
}
