// ClickMatch Input Validation
// All validation functions return { valid, error? } for easy consumption by route handlers.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_COLOR_REGEX = /^[0-9A-Fa-f]{6}$/;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate email format.
 * Must be a string matching RFC-like pattern, max 254 chars.
 */
export function validateEmail(email: unknown): ValidationResult {
  if (typeof email !== 'string') {
    return { valid: false, error: 'Email must be a string' };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }
  if (email.length > 254) {
    return { valid: false, error: 'Email too long (max 254 characters)' };
  }
  return { valid: true };
}

/**
 * Validate password.
 * Must be a string with 8-128 characters.
 */
export function validatePassword(password: unknown): ValidationResult {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'Password too long (max 128 characters)' };
  }
  return { valid: true };
}

/**
 * Validate canvas coordinates.
 * x must be 0-1919, y must be 0-1439 (1920x1440 canvas).
 */
export function validateCoordinate(x: unknown, y: unknown): ValidationResult {
  if (typeof x !== 'number' || typeof y !== 'number') {
    return { valid: false, error: 'Coordinates must be numbers' };
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return { valid: false, error: 'Coordinates must be integers' };
  }
  if (x < 0 || x > 1919) {
    return { valid: false, error: 'X coordinate must be between 0 and 1919' };
  }
  if (y < 0 || y > 1439) {
    return { valid: false, error: 'Y coordinate must be between 0 and 1439' };
  }
  return { valid: true };
}

/**
 * Validate hex color string.
 * Must be 6-character hex (e.g. FF0000, a1b2c3).
 */
export function validateColor(color: unknown): ValidationResult {
  if (typeof color !== 'string') {
    return { valid: false, error: 'Color must be a string' };
  }
  if (!HEX_COLOR_REGEX.test(color)) {
    return {
      valid: false,
      error: 'Color must be a 6-character hex string (e.g. FF0000)',
    };
  }
  return { valid: true };
}

/**
 * Validate top-up amount in cents.
 * Min $1.00 (100 cents), max $1,000.00 (100,000 cents).
 */
export function validateAmountCents(amount: unknown): ValidationResult {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    return { valid: false, error: 'Amount must be an integer (in cents)' };
  }
  if (amount < 100) {
    return { valid: false, error: 'Minimum top-up is $1.00 (100 cents)' };
  }
  if (amount > 100000) {
    return { valid: false, error: 'Maximum top-up is $1,000.00 (100,000 cents)' };
  }
  return { valid: true };
}

/**
 * Validate pagination limit.
 * Must be 1 <= limit <= max (default max = 100 for leaderboard, 1000 for events).
 */
export function validateLimit(limit: unknown, max: number = 100): ValidationResult {
  const val = typeof limit === 'string' ? parseInt(limit, 10) : limit;
  if (typeof val !== 'number' || !Number.isInteger(val)) {
    return { valid: false, error: 'Limit must be an integer' };
  }
  if (val < 1) {
    return { valid: false, error: 'Limit must be at least 1' };
  }
  if (val > max) {
    return { valid: false, error: `Limit must be at most ${max}` };
  }
  return { valid: true };
}

/**
 * Validate after_id cursor.
 * Must be a non-negative integer. Undefined/null is OK (treated as 0).
 */
export function validateAfterId(afterId: unknown): ValidationResult {
  if (afterId === undefined || afterId === null) {
    return { valid: true };
  }
  const val = typeof afterId === 'string' ? parseInt(afterId, 10) : afterId;
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
    return { valid: false, error: 'after_id must be a non-negative integer' };
  }
  return { valid: true };
}
