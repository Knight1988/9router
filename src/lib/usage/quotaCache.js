/**
 * Unified server-side quota cache.
 *
 * A single background sweep (configurable interval, default 5 min) refreshes raw
 * usage data for every active eligible connection and stores it in a globalThis
 * in-memory cache. Both the dashboard snapshot API and SmartRouting read from
 * this same cache, so both systems always see consistent, server-fresh quota
 * regardless of whether any browser is open.
 *
 * Singleton via globalThis to survive Next.js HMR without spawning duplicate timers.
 */

import { getSettings, getProviderConnections } from "@/lib/localDb";
import { fetchUsageForConnection } from "@/lib/usage/connectionUsage";

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
const QUOTA_FETCH_CONCURRENCY = 6;

// Singleton state — survives Next.js hot reload
const g = (globalThis.__quotaCache ??= {
  /** @type {Map<string, { usage: object, fetchedAt: number, error: string|null }>} */
  entries: new Map(),
  /** @type {Map<string, Promise<object>>} in-flight dedup */
  inflight: new Map(),
  timer: null,
  running: false,
  lastRunAt: null,
});

// ─── Cache read/write helpers ──────────────────────────────────────────────────

/**
 * Return the cached entry for `connectionId` if present and not older than
 * `maxAgeMs` (omit to accept any age).
 * @param {string} connectionId
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {{ usage: object, fetchedAt: number, error: string|null } | undefined}
 */
export function getCachedUsage(connectionId, { maxAgeMs } = {}) {
  const entry = g.entries.get(connectionId);
  if (!entry) return undefined;
  if (maxAgeMs !== undefined && Date.now() - entry.fetchedAt > maxAgeMs) return undefined;
  return entry;
}

/**
 * Return a plain-object snapshot of all cached entries, optionally filtered to
 * the provided array of connectionIds.
 * @param {string[]} [ids]
 * @returns {Record<string, { usage: object, fetchedAt: number, error: string|null }>}
 */
export function getAllCachedUsage(ids) {
  const result = {};
  const keys = ids && ids.length > 0 ? ids : Array.from(g.entries.keys());
  for (const id of keys) {
    const entry = g.entries.get(id);
    if (entry) result[id] = entry;
  }
  return result;
}

/**
 * Write (or overwrite) a cache entry. Called by both the sweep and the
 * per-connection API route so manual refreshes stay consistent.
 * @param {string} connectionId
 * @param {object|null} usage
 * @param {string|null} [error]
 */
export function setCachedUsage(connectionId, usage, error = null) {
  g.entries.set(connectionId, { usage: usage ?? null, fetchedAt: Date.now(), error });
}

// ─── Per-connection refresh (with in-flight dedup) ─────────────────────────────

/**
 * Refresh quota for a single connection, with in-flight dedup so concurrent
 * callers (sweep + manual refresh) never double-fetch the same connection.
 * @param {object} connection - full connection row from the DB
 * @returns {Promise<object>} the raw usage object
 */
export async function refreshConnectionUsage(connection) {
  const id = connection.id;

  // Return existing in-flight promise if one is already running for this id
  if (g.inflight.has(id)) {
    return g.inflight.get(id);
  }

  const promise = (async () => {
    try {
      const usage = await fetchUsageForConnection(connection);
      setCachedUsage(id, usage, null);
      return usage;
    } catch (err) {
      setCachedUsage(id, null, err.message);
      throw err;
    } finally {
      g.inflight.delete(id);
    }
  })();

  g.inflight.set(id, promise);
  return promise;
}

// ─── Concurrency-limited bulk refresh ─────────────────────────────────────────

/**
 * Run an array of zero-arg async thunks with at most `limit` concurrent executions.
 * @param {Array<() => Promise<any>>} thunks
 * @param {number} limit
 */
async function runWithConcurrency(thunks, limit) {
  const queue = [...thunks];
  let active = 0;
  let index = 0;

  return new Promise((resolve, reject) => {
    let settled = 0;
    const total = queue.length;
    if (total === 0) { resolve([]); return; }

    const results = new Array(total);
    let rejected = false;

    function next() {
      while (active < limit && index < total) {
        const i = index++;
        active++;
        queue[i]()
          .then((val) => { results[i] = val; })
          .catch(() => { /* non-fatal — individual errors stored in cache */ })
          .finally(() => {
            active--;
            settled++;
            if (settled === total) resolve(results);
            else if (!rejected) next();
          });
      }
    }
    next();
  });
}

/**
 * Refresh quota for ALL active, eligible connections.
 * Running-guarded — concurrent calls are no-ops.
 * @returns {Promise<void>}
 */
export async function refreshAllConnectionsUsage() {
  if (g.running) return;
  g.running = true;
  try {
    const all = await getProviderConnections();
    const active = (all || []).filter((c) => c.isActive !== false);

    if (active.length === 0) {
      console.log("[QuotaCache] No active connections to refresh");
      return;
    }

    console.log(`[QuotaCache] Refreshing quota for ${active.length} connections…`);
    const start = Date.now();

    const thunks = active.map((conn) => () =>
      refreshConnectionUsage(conn).catch(() => null) // absorb individual errors
    );

    await runWithConcurrency(thunks, QUOTA_FETCH_CONCURRENCY);

    const durationMs = Date.now() - start;
    console.log(`[QuotaCache] Refresh complete in ${durationMs}ms`);
    g.lastRunAt = new Date();
  } catch (err) {
    console.warn("[QuotaCache] Sweep error:", err.message);
  } finally {
    g.running = false;
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function clampInterval(minutes) {
  const n = Number.parseInt(minutes, 10);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, n));
}

/**
 * Start (or restart) the quota-cache scheduler using the current interval
 * setting. Safe to call multiple times — clears any existing timer first.
 */
export async function startQuotaCacheScheduler() {
  stopQuotaCacheScheduler();

  let intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  try {
    const settings = await getSettings();
    intervalMinutes = clampInterval(settings.quotaRefreshIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
  } catch {
    // use default
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`[QuotaCache] Scheduler started (interval: ${intervalMinutes}m)`);

  g.timer = setInterval(async () => {
    try {
      await refreshAllConnectionsUsage();
    } catch (err) {
      console.warn("[QuotaCache] Scheduler tick error:", err.message);
    }
  }, intervalMs);

  // Don't block startup — let the rest of the app initialise first
  if (g.timer.unref) g.timer.unref();

  setTimeout(async () => {
    try {
      await refreshAllConnectionsUsage();
    } catch (err) {
      console.warn("[QuotaCache] Initial sweep error:", err.message);
    }
  }, 4000);
}

/**
 * Stop the scheduler.
 */
export function stopQuotaCacheScheduler() {
  if (g.timer) {
    clearInterval(g.timer);
    g.timer = null;
    console.log("[QuotaCache] Scheduler stopped");
  }
}

/**
 * Return scheduler status for debugging / API.
 */
export function getQuotaCacheStatus() {
  return {
    active: g.timer !== null,
    running: g.running,
    lastRunAt: g.lastRunAt?.toISOString() ?? null,
    entryCount: g.entries.size,
    inflightCount: g.inflight.size,
  };
}
