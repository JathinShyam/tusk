import { AppError } from "./errors.js";

// shortcut: per-process fixed window; move to a shared store when the API
// runs more than one process (Phase 7 PgBouncer/scale work).
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_KEYS = 10_000;

const windows = new Map<string, { count: number; resetAt: number }>();

export function checkAuthRateLimit(key: string): void {
  const now = Date.now();

  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    if (windows.size >= MAX_KEYS && !pruneExpired(now)) return;
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    throw new AppError(
      "RATE_LIMITED",
      429,
      "Too many attempts; try again later",
    );
  }
}

function pruneExpired(now: number): boolean {
  for (const [key, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(key);
  }
  return windows.size < MAX_KEYS;
}
