// ClickMatch TypeScript Type Definitions
// Shared types for the Workers HTTP API

// ===================== Database Row Types =====================

export interface User {
  id: string;
  email: string;
  password_hash: string;
  balance: number;
  total_clicks: number;
  created_at: string;
}

export interface UserPublic {
  id: string;
  email: string;
  balance: number;
  total_clicks: number;
  created_at: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  amount_cents: number;
  clicks_purchased: number;
  tx_hash: string | null;
  status: 'pending' | 'confirmed' | 'rejected';
  created_at: string;
  approved_at: string | null;
}

export interface Event {
  id: number;
  x: number;
  y: number;
  color: string;
  user_id: string;
  timestamp: string;
}

export interface Competition {
  id: string;
  phase: number;
  starts_at: string;
  ends_at: string | null;
  status: 'pending' | 'active' | 'finished' | 'cancelled';
}

export interface CanvasSnapshot {
  id: string;
  r2_key: string;
  event_id_at: number;
  size_bytes: number;
  created_at: string;
}

// ===================== API Request Types =====================

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface TopUpRequest {
  amount_cents: number;
}

// ===================== API Response Types =====================

export interface AuthResponse {
  user: UserPublic;
  token: string;
}

export interface CanvasStateResponse {
  snapshot_url: string | null;
  event_id_at: number;
  competition: {
    phase: number;
    ends_at: string | null;
    status: string;
  } | null;
}

export interface EventsResponse {
  events: Event[];
  next_cursor: number | null;
}

export interface CompetitionResponse {
  id: string;
  phase: number;
  starts_at: string;
  ends_at: string | null;
  status: string;
  total_clicks: number;
  online_players: number;
}

export interface TopUpResponse {
  tx_id: string;
  clicks: number;
  payment_address: string;
  status: string;
}

export interface LeaderboardEntry {
  rank: number;
  user_id: string;
  email_preview: string;
  total_clicks: number;
}

export interface LeaderboardResponse {
  rankings: LeaderboardEntry[];
}

export interface ErrorResponse {
  error: string;
  code?: number;
}

// ===================== Session Types (No-Auth) =====================

export interface Session {
  session_id: string;
  clicks: number;
  created_at: string;
  updated_at: string;
}

// ===================== PayPal Types =====================

export interface PayPalOrderRequest {
  session_id: string;
  amount_cents: number; // $1.00 = 100 clicks
}

// ===================== JWT Types =====================

export interface JwtPayload {
  sub: string; // user_id
  email: string;
  iat: number;
  exp: number;
}

// ===================== Worker Environment =====================

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  PAYMENT_ADDRESS?: string;
  CANVAS_WIDTH?: string;
  CANVAS_HEIGHT?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_API_URL?: string; // https://api-m.paypal.com (live) or https://api-m.sandbox.paypal.com (sandbox)
}
