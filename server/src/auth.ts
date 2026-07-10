// ClickMatch JWT Authentication Module
// Uses Web Crypto API only — no npm packages. Cloudflare Workers compatible.
// JWT: HS256 (HMAC-SHA256), 24h expiry.
// Passwords: PBKDF2-SHA256, 100,000 iterations, 16-byte random salt.

import { JwtPayload } from './types';

// ===================== Base64URL Utilities =====================

function base64urlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4 !== 0) {
    str += '=';
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const encoder = new TextEncoder();

// ===================== Crypto Key Derivation =====================

async function getSigningKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret);
  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// ===================== JWT Token Creation & Verification =====================

/**
 * Create a JWT token signed with HS256.
 * Payload includes sub (user_id), email, iat, exp (now + 24h).
 */
export async function createToken(
  payload: { sub: string; email: string },
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwtPayload: JwtPayload = {
    sub: payload.sub,
    email: payload.email,
    iat: now,
    exp: now + 86400, // 24 hours
  };

  const header = { alg: 'HS256', typ: 'JWT' };

  const headerB64 = base64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(encoder.encode(JSON.stringify(jwtPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signingInput),
  );
  const signatureB64 = base64urlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Verify a JWT token and return the decoded payload.
 * Returns null if the token is invalid, expired, or malformed.
 */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await getSigningKey(secret);
    const signature = base64urlDecode(signatureB64);

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(signingInput),
    );

    if (!valid) return null;

    const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
    const payload: JwtPayload = JSON.parse(payloadJson);

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract and verify JWT from the Authorization header.
 * Expects format: "Bearer <token>"
 * Returns the decoded payload or null.
 */
export async function authenticateRequest(
  request: Request,
  secret: string,
): Promise<JwtPayload | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  return verifyToken(match[1], secret);
}

// ===================== Password Hashing (PBKDF2) =====================

/**
 * Hash a password using PBKDF2 with SHA-256.
 * Returns format: "{iterations}:{salt_base64url}:{hash_base64url}"
 *
 * Uses 100,000 iterations and 16-byte random salt — a reasonable
 * trade-off for Workers' CPU limits (bcrypt would be too slow on edge).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );

  const hashBytes = new Uint8Array(derivedBits);
  const saltB64 = base64urlEncode(salt);
  const hashB64 = base64urlEncode(hashBytes);

  return `${iterations}:${saltB64}:${hashB64}`;
}

/**
 * Verify a password against a stored hash.
 * Extracts iterations, salt, and expected hash from the stored string,
 * then recomputes PBKDF2 and compares in constant-time.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;

    const iterations = parseInt(parts[0], 10);
    if (isNaN(iterations) || iterations < 1) return false;

    const salt = base64urlDecode(parts[1]);
    const expectedHash = parts[2];

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      256,
    );

    const hashBytes = new Uint8Array(derivedBits);
    const actualHash = base64urlEncode(hashBytes);

    // Constant-time comparison: compute differences byte-by-byte
    if (actualHash.length !== expectedHash.length) return false;
    let diff = 0;
    for (let i = 0; i < actualHash.length; i++) {
      diff |= actualHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}
