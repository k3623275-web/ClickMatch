// ClickMatch D1 Database Operations Layer
// All SQL queries are parameterized to prevent SQL injection.
// Each method maps to one logical operation defined in schema.md query patterns.

import { User, Transaction, Competition, CanvasSnapshot, Event } from './types';

/**
 * Generate a UUID v4 (uses crypto.randomUUID available in Workers runtime).
 */
function uuid(): string {
  return crypto.randomUUID();
}

export class DB {
  private d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  // ===================== Users =====================

  /**
   * Create a new user. Returns the full user row.
   * Email uniqueness is enforced by D1 UNIQUE constraint.
   */
  async createUser(email: string, passwordHash: string): Promise<User> {
    const id = uuid();
    await this.d1
      .prepare(
        'INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)',
      )
      .bind(id, email, passwordHash)
      .run();
    return (await this.getUserById(id))!;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const result = await this.d1
      .prepare('SELECT * FROM users WHERE email = ?')
      .bind(email)
      .first<User>();
    return result ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const result = await this.d1
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(id)
      .first<User>();
    return result ?? null;
  }

  // ===================== Transactions =====================

  /**
   * Create a pending top-up transaction.
   * Phase 1: manual confirmation. Admin confirms via separate flow.
   */
  async createTransaction(
    userId: string,
    amountCents: number,
    clicksPurchased: number,
  ): Promise<Transaction> {
    const id = uuid();
    await this.d1
      .prepare(
        `INSERT INTO transactions (id, user_id, amount_cents, clicks_purchased, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .bind(id, userId, amountCents, clicksPurchased)
      .run();

    const result = await this.d1
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .bind(id)
      .first<Transaction>();
    return result!;
  }

  /**
   * Confirm a pending transaction and credit user balance.
   * Runs two updates: mark transaction as confirmed + increment user balance.
   * Returns the updated transaction and user, or null if tx not found/not pending.
   */
  async confirmTransaction(
    txId: string,
    txHash: string,
  ): Promise<{ transaction: Transaction; user: User } | null> {
    // Check transaction exists and is pending
    const tx = await this.d1
      .prepare('SELECT * FROM transactions WHERE id = ? AND status = ?')
      .bind(txId, 'pending')
      .first<Transaction>();

    if (!tx) return null;

    const now = new Date().toISOString();

    // Update transaction status
    await this.d1
      .prepare(
        `UPDATE transactions
         SET status = 'confirmed', tx_hash = ?, approved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(txHash, now, txId)
      .run();

    // Credit user balance: $0.01 per click = amount_cents clicks
    await this.d1
      .prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
      .bind(tx.clicks_purchased, tx.user_id)
      .run();

    const updatedTx = await this.d1
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .bind(txId)
      .first<Transaction>();

    const user = await this.getUserById(tx.user_id);
    return { transaction: updatedTx!, user: user! };
  }

  async getTransactionById(id: string): Promise<Transaction | null> {
    const result = await this.d1
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .bind(id)
      .first<Transaction>();
    return result ?? null;
  }

  // ===================== Competition =====================

  /**
   * Get the currently active competition (latest by starts_at).
   */
  async getCurrentCompetition(): Promise<Competition | null> {
    const result = await this.d1
      .prepare(
        `SELECT * FROM competitions
         WHERE status = 'active'
         ORDER BY starts_at DESC
         LIMIT 1`,
      )
      .first<Competition>();
    return result ?? null;
  }

  /**
   * Get total clicks across all users (fast: reads users.total_clicks counter).
   */
  async getTotalClicks(): Promise<number> {
    const result = await this.d1
      .prepare('SELECT COALESCE(SUM(total_clicks), 0) AS total FROM users')
      .first<{ total: number }>();
    return result?.total ?? 0;
  }

  // ===================== Canvas Snapshots =====================

  /**
   * Get the most recent canvas snapshot metadata.
   * The actual PNG is in R2; we only return the R2 key reference.
   */
  async getLatestSnapshot(): Promise<CanvasSnapshot | null> {
    const result = await this.d1
      .prepare(
        'SELECT * FROM canvas_snapshots ORDER BY created_at DESC LIMIT 1',
      )
      .first<CanvasSnapshot>();
    return result ?? null;
  }

  // ===================== Events =====================

  /**
   * Cursor-based paginated event query from events_live view.
   * Fetches limit+1 rows to detect if there are more results.
   * Returns events and the cursor for the next page (null if no more).
   */
  async getEvents(
    afterId: number,
    limit: number,
  ): Promise<{ events: Event[]; nextCursor: number | null }> {
    // Fetch one extra row to check for more results
    const result = await this.d1
      .prepare(
        `SELECT * FROM events_live
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .bind(afterId, limit + 1)
      .all<Event>();

    const hasMore = result.results.length > limit;
    const events = hasMore
      ? result.results.slice(0, limit)
      : result.results;

    return {
      events,
      nextCursor: hasMore ? events[events.length - 1].id : null,
    };
  }

  // ===================== Leaderboard =====================

  /**
   * Get ranked leaderboard combining live events and archived aggregates.
   * Uses the composite query from schema.md §3.1.
   * Emails are partially masked for privacy: "u***@example.com"
   */
  async getLeaderboard(
    limit: number,
  ): Promise<
    {
      rank: number;
      user_id: string;
      email_preview: string;
      total_clicks: number;
    }[]
  > {
    const result = await this.d1
      .prepare(
        `SELECT
          u.id AS user_id,
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
        WHERE COALESCE(live.cnt, 0) + COALESCE(arch.cnt, 0) > 0
        ORDER BY total DESC
        LIMIT ?`,
      )
      .bind(limit)
      .all<{ user_id: string; email: string; total: number }>();

    return result.results.map((row, idx) => {
      const atIndex = row.email.indexOf('@');
      let emailPreview: string;
      if (atIndex <= 1) {
        // Very short local part: a@b.com → a***@b.com
        emailPreview =
          row.email[0] + '***@' + row.email.slice(atIndex + 1);
      } else {
        // Normal: user@example.com → u***@example.com
        emailPreview =
          row.email[0] + '***' + row.email.slice(atIndex);
      }

      return {
        rank: idx + 1,
        user_id: row.user_id,
        email_preview: emailPreview,
        total_clicks: row.total,
      };
    });
  }

  // ===================== Online Players =====================

  // ===================== Sessions (No-Auth) =====================

  async getOrCreateSession(sessionId: string): Promise<{ clicks: number }> {
    await this.d1
      .prepare(
        `INSERT INTO sessions (session_id, clicks) VALUES (?, 0)
         ON CONFLICT(session_id) DO UPDATE SET updated_at = datetime('now')`,
      )
      .bind(sessionId)
      .run();
    const row = await this.d1
      .prepare('SELECT clicks FROM sessions WHERE session_id = ?')
      .bind(sessionId)
      .first<{ clicks: number }>();
    return { clicks: row?.clicks ?? 0 };
  }

  async addSessionClicks(sessionId: string, delta: number): Promise<{ clicks: number }> {
    await this.d1
      .prepare('UPDATE sessions SET clicks = clicks + ?, updated_at = datetime("now") WHERE session_id = ?')
      .bind(delta, sessionId)
      .run();
    const row = await this.d1
      .prepare('SELECT clicks FROM sessions WHERE session_id = ?')
      .bind(sessionId)
      .first<{ clicks: number }>();
    return { clicks: row?.clicks ?? 0 };
  }

  async consumeClick(sessionId: string): Promise<{ clicks: number }> {
    // First ensure session exists and get current clicks
    const row = await this.d1
      .prepare('SELECT clicks FROM sessions WHERE session_id = ?')
      .bind(sessionId)
      .first<{ clicks: number }>();
    if (!row || row.clicks <= 0) return { clicks: 0 };
    await this.d1
      .prepare('UPDATE sessions SET clicks = clicks - 1, updated_at = datetime("now") WHERE session_id = ? AND clicks > 0')
      .bind(sessionId)
      .run();
    const updated = await this.d1
      .prepare('SELECT clicks FROM sessions WHERE session_id = ?')
      .bind(sessionId)
      .first<{ clicks: number }>();
    return { clicks: updated?.clicks ?? 0 };
  }

  /**
   * Approximate online player count: distinct users who clicked in the last 5 minutes.
   * For Phase 1 this is a reasonable proxy. A future upgrade could use Durable Object
   * connection count for real-time accuracy.
   */
  async getOnlinePlayerCount(): Promise<number> {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = await this.d1
      .prepare(
        `SELECT COUNT(DISTINCT user_id) AS count
         FROM events_live
         WHERE timestamp >= ?`,
      )
      .bind(fiveMinAgo)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }
}
