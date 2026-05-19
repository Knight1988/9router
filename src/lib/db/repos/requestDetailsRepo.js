import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : envEnabled;
    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

const healthCache = new Map();
const COUNT_CACHE_TTL_MS = 60_000;
let countCache = null;
let countCacheTs = 0;

export function invalidateHealthCache() {
  healthCache.clear();
}

export function invalidateCountCache() {
  countCache = null;
  countCacheTs = 0;
}

function healthCacheTtl(startDate) {
  if (!startDate) return 120_000;
  const age = Date.now() - new Date(startDate).getTime();
  return age < 6 * 60 * 60 * 1000 ? 30_000 : 120_000;
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayLocalStartIso() {
  const today = getLocalDateKey(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function dateKeyFromStartDate(startDateIso) {
  const d = new Date(startDateIso);
  return getLocalDateKey(d);
}

async function getLiveHealthRows({ startDate, provider } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (startDate) { conds.push("timestamp >= ?"); params.push(new Date(startDate).toISOString()); }
  if (provider) { conds.push("provider = ?"); params.push(provider); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  return db.all(
    `SELECT
      provider,
      model,
      COUNT(*) AS totalRequests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
      SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errorCount,
      0 AS rateLimitCount,
      MAX(timestamp) AS lastUsed,
      AVG(CASE WHEN json_extract(data, '$.latency.total') > 0 THEN json_extract(data, '$.latency.total') END) AS avgLatency,
      AVG(CASE WHEN json_extract(data, '$.latency.ttft') > 0 THEN json_extract(data, '$.latency.ttft') END) AS avgTtft
    FROM requestDetails ${where}
    GROUP BY provider, model`,
    params
  );
}

function mergeHealthRows(daily, live) {
  const map = {};
  for (const r of daily) {
    const key = `${r.provider}|${r.model}`;
    map[key] = {
      provider: r.provider,
      model: r.model,
      totalRequests: r.totalRequests || 0,
      successCount: r.successCount || 0,
      errorCount: r.errorCount || 0,
      rateLimitCount: r.rateLimitCount || 0,
      latencySum: r.latencySum || 0,
      latencyCount: r.latencyCount || 0,
      ttftSum: r.ttftSum || 0,
      ttftCount: r.ttftCount || 0,
      lastUsed: r.lastUsed,
    };
  }
  for (const r of live) {
    const key = `${r.provider}|${r.model}`;
    if (!map[key]) {
      map[key] = {
        provider: r.provider,
        model: r.model,
        totalRequests: 0,
        successCount: 0,
        errorCount: 0,
        rateLimitCount: 0,
        latencySum: 0,
        latencyCount: 0,
        ttftSum: 0,
        ttftCount: 0,
        lastUsed: null,
      };
    }
    const e = map[key];
    e.totalRequests += r.totalRequests || 0;
    e.successCount += r.successCount || 0;
    e.errorCount += r.errorCount || 0;
    e.rateLimitCount += r.rateLimitCount || 0;
    if (r.avgLatency != null) {
      e.latencySum += r.avgLatency * (r.totalRequests || 0);
      e.latencyCount += r.totalRequests || 0;
    }
    if (r.avgTtft != null) {
      e.ttftSum += r.avgTtft * (r.totalRequests || 0);
      e.ttftCount += r.totalRequests || 0;
    }
    if (!e.lastUsed || (r.lastUsed && r.lastUsed > e.lastUsed)) e.lastUsed = r.lastUsed;
  }
  return Object.values(map).map((e) => ({
    provider: e.provider,
    model: e.model,
    totalRequests: e.totalRequests,
    successCount: e.successCount,
    errorCount: e.errorCount,
    rateLimitCount: e.rateLimitCount,
    lastUsed: e.lastUsed,
    avgLatency: e.latencyCount > 0 ? e.latencySum / e.latencyCount : null,
    avgTtft: e.ttftCount > 0 ? e.ttftSum / e.ttftCount : null,
  }));
}

export async function getProviderHealthStats({ startDate, provider } = {}) {
  const cacheKey = `${startDate || ""}|${provider || ""}`;
  const cached = healthCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < healthCacheTtl(startDate)) {
    return cached.data;
  }

  // Determine if the window spans multiple days (needs daily table)
  const startOfToday = todayLocalStartIso();
  const isMultiDay = !startDate || new Date(startDate).toISOString() < startOfToday;

  let data;
  if (isMultiDay) {
    const { getDailyHealthRows } = await import("./providerHealthRepo.js");
    const startDateKey = startDate ? dateKeyFromStartDate(startDate) : undefined;
    const [dailyRows, liveRows] = await Promise.all([
      getDailyHealthRows({ startDateKey, provider }),
      getLiveHealthRows({ startDate: startOfToday, provider }),
    ]);
    data = mergeHealthRows(dailyRows, liveRows);
  } else {
    data = await getLiveHealthRows({ startDate, provider });
  }

  healthCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

export async function getTotalRecordCount() {
  if (countCache !== null && (Date.now() - countCacheTs) < COUNT_CACHE_TTL_MS) {
    return countCache;
  }
  const db = await getAdapter();
  const row = db.get("SELECT COUNT(*) AS count FROM requestDetails");
  countCache = row ? row.count : 0;
  countCacheTs = Date.now();
  return countCache;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
