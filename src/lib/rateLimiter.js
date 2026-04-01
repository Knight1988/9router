const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Map<string, { attempts: number[], lockedUntil: number|null }>
const store = new Map();

let cleanupStarted = false;

function startCleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of store) {
      if (entry.lockedUntil && entry.lockedUntil <= now) {
        entry.lockedUntil = null;
        entry.attempts = [];
      }
      entry.attempts = entry.attempts.filter((t) => now - t < WINDOW_MS);
      if (entry.attempts.length === 0 && !entry.lockedUntil) {
        store.delete(ip);
      }
    }
  }, CLEANUP_INTERVAL_MS).unref();
}

export function getClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return "unknown";
}

export function checkRateLimit(ip) {
  startCleanup();
  const entry = store.get(ip);
  if (!entry) {
    return { limited: false, retryAfterMs: null, remaining: MAX_ATTEMPTS };
  }

  const now = Date.now();

  if (entry.lockedUntil && entry.lockedUntil > now) {
    return {
      limited: true,
      retryAfterMs: entry.lockedUntil - now,
      remaining: 0,
    };
  }

  // Lockout expired — reset
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    entry.lockedUntil = null;
    entry.attempts = [];
  }

  entry.attempts = entry.attempts.filter((t) => now - t < WINDOW_MS);
  return {
    limited: false,
    retryAfterMs: null,
    remaining: MAX_ATTEMPTS - entry.attempts.length,
  };
}

export function recordFailedAttempt(ip) {
  startCleanup();
  const now = Date.now();
  let entry = store.get(ip);
  if (!entry) {
    entry = { attempts: [], lockedUntil: null };
    store.set(ip, entry);
  }

  entry.attempts.push(now);
  entry.attempts = entry.attempts.filter((t) => now - t < WINDOW_MS);

  if (entry.attempts.length >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
    return {
      locked: true,
      remaining: 0,
      retryAfterMs: LOCKOUT_MS,
    };
  }

  return {
    locked: false,
    remaining: MAX_ATTEMPTS - entry.attempts.length,
    retryAfterMs: null,
  };
}

export function resetAttempts(ip) {
  store.delete(ip);
}
