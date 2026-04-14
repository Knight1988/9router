import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const isCloud = typeof caches !== "undefined" && typeof caches === "object";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

function getAppName() {
  return "9router";
}

function getUserDataDir() {
  if (isCloud) return "/tmp";
  if (process.env.DATA_DIR) return process.env.DATA_DIR;

  const platform = process.platform;
  const homeDir = os.homedir();
  const appName = getAppName();

  if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), appName);
  }
  return path.join(homeDir, `.${appName}`);
}

const DATA_DIR = getUserDataDir();
const DB_FILE = isCloud ? null : path.join(DATA_DIR, "request-details.db");
const LEGACY_JSON_FILE = isCloud ? null : path.join(DATA_DIR, "request-details.json");

if (!isCloud && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let dbInstance = null;

function getDb() {
  if (isCloud) return null;
  if (dbInstance) return dbInstance;

  const Database = require("better-sqlite3");
  const db = new Database(DB_FILE);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_details (
      id TEXT PRIMARY KEY,
      provider TEXT,
      model TEXT,
      connectionId TEXT,
      timestamp TEXT NOT NULL,
      status TEXT,
      latency TEXT,
      tokens TEXT,
      request TEXT,
      providerRequest TEXT,
      providerResponse TEXT,
      response TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON request_details(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_provider ON request_details(provider);
    CREATE INDEX IF NOT EXISTS idx_model ON request_details(model);
    CREATE INDEX IF NOT EXISTS idx_provider_health ON request_details(timestamp, provider, model);
  `);

  dbInstance = db;

  // Migrate from legacy JSON file if it exists
  migrateLegacyJson(db);

  return db;
}

function migrateLegacyJson(db) {
  if (!LEGACY_JSON_FILE || !fs.existsSync(LEGACY_JSON_FILE)) return;

  try {
    const raw = fs.readFileSync(LEGACY_JSON_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const records = parsed?.records;
    if (!Array.isArray(records) || records.length === 0) {
      fs.renameSync(LEGACY_JSON_FILE, LEGACY_JSON_FILE + ".migrated");
      return;
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO request_details
        (id, provider, model, connectionId, timestamp, status, latency, tokens, request, providerRequest, providerResponse, response)
      VALUES
        (@id, @provider, @model, @connectionId, @timestamp, @status, @latency, @tokens, @request, @providerRequest, @providerResponse, @response)
    `);

    const insertMany = db.transaction((rows) => {
      for (const r of rows) {
        insert.run({
          id: r.id || generateDetailId(r.model),
          provider: r.provider || null,
          model: r.model || null,
          connectionId: r.connectionId || null,
          timestamp: r.timestamp || new Date().toISOString(),
          status: r.status || null,
          latency: JSON.stringify(r.latency || {}),
          tokens: JSON.stringify(r.tokens || {}),
          request: JSON.stringify(r.request || {}),
          providerRequest: JSON.stringify(r.providerRequest || {}),
          providerResponse: JSON.stringify(r.providerResponse || {}),
          response: JSON.stringify(r.response || {}),
        });
      }
    });

    insertMany(records);
    fs.renameSync(LEGACY_JSON_FILE, LEGACY_JSON_FILE + ".migrated");
    console.log(`[requestDetailsDb] Migrated ${records.length} records from JSON to SQLite`);
  } catch (err) {
    console.error("[requestDetailsDb] Migration failed:", err);
  }
}

// Config cache
let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    // Support both key names for backward compatibility
    const enabledSetting = settings.enableObservability ?? settings.observabilityEnabled;
    const enabled = typeof enabledSetting === "boolean" ? enabledSetting : envEnabled;

    cachedConfig = {
      enabled,
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }

  cachedConfigTs = Date.now();
  return cachedConfig;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function safeJsonStringify(obj, maxSize) {
  try {
    const str = JSON.stringify(obj);
    if (str.length > maxSize) {
      return JSON.stringify({ _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) });
    }
    return str;
  } catch {
    return "{}";
  }
}

// Batch write queue
let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

async function flushToDatabase() {
  if (isCloud || isFlushing || writeBuffer.length === 0) return;

  isFlushing = true;
  try {
    const itemsToSave = [...writeBuffer];
    writeBuffer = [];

    const db = getDb();
    const config = await getObservabilityConfig();

    const insert = db.prepare(`
      INSERT OR REPLACE INTO request_details
        (id, provider, model, connectionId, timestamp, status, latency, tokens, request, providerRequest, providerResponse, response)
      VALUES
        (@id, @provider, @model, @connectionId, @timestamp, @status, @latency, @tokens, @request, @providerRequest, @providerResponse, @response)
    `);

    const insertMany = db.transaction((items) => {
      for (const item of items) {
        if (!item.id) item.id = generateDetailId(item.model);
        if (!item.timestamp) item.timestamp = new Date().toISOString();
        if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

        const maxSize = config.maxJsonSize;

        insert.run({
          id: item.id,
          provider: item.provider || null,
          model: item.model || null,
          connectionId: item.connectionId || null,
          timestamp: item.timestamp,
          status: item.status || null,
          latency: safeJsonStringify(item.latency || {}, maxSize),
          tokens: safeJsonStringify(item.tokens || {}, maxSize),
          request: safeJsonStringify(item.request || {}, maxSize),
          providerRequest: safeJsonStringify(item.providerRequest || {}, maxSize),
          providerResponse: safeJsonStringify(item.providerResponse || {}, maxSize),
          response: safeJsonStringify(item.response || {}, maxSize),
        });
      }
    });

    insertMany(itemsToSave);
  } catch (error) {
    console.error("[requestDetailsDb] Batch write failed:", error);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  if (isCloud) return;

  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  if (writeBuffer.length >= config.batchSize) {
    await flushToDatabase();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushToDatabase().catch(() => {});
      flushTimer = null;
    }, config.flushIntervalMs);
  }
}

function parseJsonField(val) {
  if (!val) return {};
  try { return JSON.parse(val); } catch { return {}; }
}

function rowToRecord(row) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    connectionId: row.connectionId,
    timestamp: row.timestamp,
    status: row.status,
    latency: parseJsonField(row.latency),
    tokens: parseJsonField(row.tokens),
    request: parseJsonField(row.request),
    providerRequest: parseJsonField(row.providerRequest),
    providerResponse: parseJsonField(row.providerResponse),
    response: parseJsonField(row.response),
  };
}

export async function getRequestDetails(filter = {}) {
  if (isCloud) {
    return { details: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0, hasNext: false, hasPrev: false } };
  }

  const db = getDb();

  const conditions = [];
  const params = {};

  if (filter.provider) { conditions.push("provider = @provider"); params.provider = filter.provider; }
  if (filter.model) { conditions.push("model = @model"); params.model = filter.model; }
  if (filter.connectionId) { conditions.push("connectionId = @connectionId"); params.connectionId = filter.connectionId; }
  if (filter.status) { conditions.push("status = @status"); params.status = filter.status; }
  if (filter.startDate) { conditions.push("timestamp >= @startDate"); params.startDate = new Date(filter.startDate).toISOString(); }
  if (filter.endDate) { conditions.push("timestamp <= @endDate"); params.endDate = new Date(filter.endDate).toISOString(); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { totalItems } = db.prepare(`SELECT COUNT(*) AS totalItems FROM request_details ${where}`).get(params);

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.prepare(`
    SELECT * FROM request_details ${where}
    ORDER BY timestamp DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset });

  const details = rows.map(rowToRecord);

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  if (isCloud) return null;

  const db = getDb();
  const row = db.prepare("SELECT * FROM request_details WHERE id = ?").get(id);
  return row ? rowToRecord(row) : null;
}

export async function getTotalRecordCount() {
  if (isCloud) return 0;
  const db = getDb();
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM request_details").get();
  return count;
}

export async function getProviderHealthStats({ startDate, provider } = {}) {
  if (isCloud) return [];

  const db = getDb();

  const conditions = [];
  const params = {};

  if (startDate) { conditions.push("timestamp >= @startDate"); params.startDate = new Date(startDate).toISOString(); }
  if (provider) { conditions.push("provider = @provider"); params.provider = provider; }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return db.prepare(`
    SELECT
      provider,
      model,
      COUNT(*) AS totalRequests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
      SUM(CASE WHEN status != 'success' AND json_extract(response, '$.status') != 429 THEN 1 ELSE 0 END) AS errorCount,
      SUM(CASE WHEN status != 'success' AND json_extract(response, '$.status') = 429 THEN 1 ELSE 0 END) AS rateLimitCount,
      MAX(timestamp) AS lastUsed,
      AVG(CASE WHEN json_extract(latency, '$.total') > 0 THEN json_extract(latency, '$.total') END) AS avgLatency,
      AVG(CASE WHEN json_extract(latency, '$.ttft') > 0 THEN json_extract(latency, '$.ttft') END) AS avgTtft
    FROM request_details ${where}
    GROUP BY provider, model
  `).all(params);
}

export async function getDistinctProviders() {
  if (isCloud) return [];
  const db = getDb();
  return db.prepare("SELECT DISTINCT provider FROM request_details WHERE provider IS NOT NULL ORDER BY provider").all()
    .map(r => r.provider);
}

// Graceful shutdown
const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
  if (dbInstance) { dbInstance.close(); dbInstance = null; }
};

function ensureShutdownHandler() {
  if (isCloud) return;

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
