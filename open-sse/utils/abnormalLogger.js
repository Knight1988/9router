import fs from "fs";
import path from "path";

const MAX_EVENTS = 500;
const MAX_DISK_BYTES = 500 * 1024 * 1024;
const MAX_STRING_LEN = 500;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const MASKED_HEADERS = new Set([
  "authorization", "x-api-key", "cookie", "proxy-authorization"
]);

const NORMAL_FINISH_REASONS = new Set([
  "stop", "tool_calls", "function_call", "end_turn",
  "STOP",
  null, undefined, ""
]);

export const ABNORMAL_SIGNALS = Object.freeze({
  EMPTY_COMPLETION: "empty_completion",
  EMPTY_STREAM: "empty_stream",
  PROVIDER_ERROR: "provider_error",
  FORMAT_MISMATCH: "format_mismatch",
  BAD_FINISH_REASON: "bad_finish_reason",
});

let DATA_DIR = null;
let logsDir = null;
let summaryLog = null;
let initDone = false;
let initFailed = false;

function initDirs() {
  if (initDone || initFailed) return;
  try {
    const { getDataDir } = getDataDirSync();
    DATA_DIR = getDataDir();
    logsDir = path.join(DATA_DIR, "logs", "abnormal");
    fs.mkdirSync(logsDir, { recursive: true });
    summaryLog = path.join(DATA_DIR, "logs", "abnormal-responses.log");
    initDone = true;
  } catch {
    initFailed = true;
  }
}

function getDataDirSync() {
  try {
    const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";
    if (!isNode) return { getDataDir: () => "." };
    const dataDir = process.env.DATA_DIR || (() => {
      const os = require("os");
      const platform = process.platform;
      if (platform === "win32") {
        return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
      }
      return path.join(os.homedir(), ".9router");
    })();
    return { getDataDir: () => dataDir };
  } catch {
    return { getDataDir: () => "." };
  }
}

function truncate(val, max = MAX_STRING_LEN) {
  if (val == null) return val;
  const s = typeof val === "string" ? val : String(val);
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max}]` : s;
}

function maskHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = MASKED_HEADERS.has(k.toLowerCase())
      ? (typeof v === "string" && v.length > 10 ? v.slice(0, 6) + "…" + v.slice(-4) : "***")
      : v;
  }
  return out;
}

function shortId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pruneOldEvents() {
  if (!logsDir) return;
  try {
    const entries = fs.readdirSync(logsDir)
      .map(name => ({ name, full: path.join(logsDir, name) }))
      .filter(e => {
        try { return fs.statSync(e.full).isDirectory(); } catch { return false; }
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    if (entries.length <= MAX_EVENTS) {
      let total = 0;
      for (const e of entries) {
        try {
          const size = dirSize(e.full);
          total += size;
        } catch { /* ignore */ }
      }
      if (total <= MAX_DISK_BYTES) return;
    }

    const toRemove = entries.length > MAX_EVENTS
      ? entries.slice(0, entries.length - MAX_EVENTS)
      : entries.slice(0, Math.ceil(entries.length * 0.1));

    for (const e of toRemove) {
      try { fs.rmSync(e.full, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function dirSize(dirPath) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dirPath)) {
      try {
        const s = fs.statSync(path.join(dirPath, f));
        total += s.size;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return total;
}

function safeWriteJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
}

function safeTruncateBody(body) {
  if (body == null) return null;
  try {
    const s = typeof body === "string" ? body : JSON.stringify(body);
    if (s.length > MAX_BODY_BYTES) {
      return { _truncated: true, _originalBytes: s.length, preview: s.slice(0, 500) };
    }
    return typeof body === "string" ? body : body;
  } catch {
    return { _truncated: true, _error: "serialize_failed" };
  }
}

function consoleWarn(signal, provider, model, connectionId, latencyMs, extra) {
  const color = signal === ABNORMAL_SIGNALS.PROVIDER_ERROR ? "\x1b[31m" : "\x1b[33m";
  const reset = "\x1b[0m";
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  const extraStr = extra ? " " + Object.entries(extra).slice(0, 4).map(([k, v]) => `${k}=${truncate(String(v ?? ""), 80)}`).join(" ") : "";
  console.warn(`${color}[${time}] ⚠️  [ABNORMAL/${signal}] ${provider}/${model} conn=${connectionId ?? "?"} latency=${latencyMs ?? "?"}ms${extraStr}${reset}`);
}

export function isAbnormalFinishReason(reason) {
  return !NORMAL_FINISH_REASONS.has(reason);
}

export function logAbnormal({ signal, provider, model, connectionId, endpoint, requestId, latencyMs, statusCode, details, clientRequest, translatedRequest, targetRequest, providerResponseBody, clientResponseBody }) {
  try {
    initDirs();
    if (initFailed || !logsDir) return;

    const ts = new Date().toISOString();
    const id = requestId || shortId();
    const tsSlug = ts.replace(/[:.]/g, "-").replace("T", "_").slice(0, 22);
    const provSlug = `${(provider || "unknown").replace(/[^a-zA-Z0-9]/g, "-")}`;
    const modelSlug = `${(model || "unknown").replace(/[^a-zA-Z0-9]/g, "-").slice(0, 30)}`;
    const dirName = `${tsSlug}_${signal}_${provSlug}-${modelSlug}_${id.slice(0, 8)}`;
    const eventDir = path.join(logsDir, dirName);

    try { fs.mkdirSync(eventDir, { recursive: true }); } catch { return; }

    const meta = {
      timestamp: ts,
      signal,
      provider,
      model,
      connectionId,
      endpoint,
      requestId: id,
      latencyMs,
      statusCode: statusCode ?? null,
      details: details || {}
    };
    safeWriteJson(path.join(eventDir, "meta.json"), meta);

    if (clientRequest) {
      safeWriteJson(path.join(eventDir, "request_source.json"), {
        endpoint: clientRequest.endpoint,
        headers: maskHeaders(clientRequest.headers),
        body: safeTruncateBody(clientRequest.body)
      });
    }
    if (translatedRequest) {
      safeWriteJson(path.join(eventDir, "request_translated.json"), safeTruncateBody(translatedRequest));
    }
    if (targetRequest) {
      safeWriteJson(path.join(eventDir, "request_target.json"), {
        url: targetRequest.url,
        headers: maskHeaders(targetRequest.headers),
        body: safeTruncateBody(targetRequest.body)
      });
    }
    if (providerResponseBody != null) {
      safeWriteJson(path.join(eventDir, "response_provider.json"), safeTruncateBody(providerResponseBody));
    }
    if (clientResponseBody != null) {
      safeWriteJson(path.join(eventDir, "response_client.json"), safeTruncateBody(clientResponseBody));
    }

    const summaryEntry = JSON.stringify({
      timestamp: ts,
      signal,
      provider,
      model,
      connectionId,
      endpoint,
      latencyMs,
      statusCode: statusCode ?? null,
      details: details || {},
      artifactsDir: dirName
    }) + "\n";

    try { fs.appendFileSync(summaryLog, summaryEntry); } catch { /* ignore */ }

    consoleWarn(signal, provider, model, connectionId, latencyMs, details);

    setImmediate(() => pruneOldEvents());
  } catch { /* never break callers */ }
}
