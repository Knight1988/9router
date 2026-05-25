const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 30;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const requestLog = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of requestLog.entries()) {
    const valid = timestamps.filter(t => now - t < WINDOW_MS);
    if (valid.length === 0) {
      requestLog.delete(key);
    } else {
      requestLog.set(key, valid);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Check if a key is within the rate limit.
 * @param {string} key - API key or identifier
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
export function checkRateLimit(key) {
  const now = Date.now();
  const timestamps = (requestLog.get(key) || []).filter(t => now - t < WINDOW_MS);

  if (timestamps.length >= MAX_REQUESTS) {
    const oldest = timestamps[0];
    const retryAfter = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }

  timestamps.push(now);
  requestLog.set(key, timestamps);
  return { allowed: true };
}
