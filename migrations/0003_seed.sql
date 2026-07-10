-- Migration 0003: Seed data
-- Inserts initial competition record (Phase 1) and a demo test user.

INSERT INTO competitions (id, phase, starts_at, ends_at, status)
VALUES (
    'phase-1',
    1,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+30 days'),
    'active'
);

INSERT INTO users (id, email, password_hash, balance, total_clicks)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'demo@clickmatch.io',
    -- bcrypt hash for "demo123" (generated placeholder – replace with real hash for production)
    '$2b$12$LJ3m4ys3GZfnYMz8k7cHXOzFh6W7YqK0LfA8jFwBxVtNcPdReS5u',
    100,
    0
);
