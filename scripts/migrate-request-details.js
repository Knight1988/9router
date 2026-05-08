#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(process.env.HOME, ".9router");
const DB_FILE = path.join(DATA_DIR, "request-details.db");
const LEGACY_JSON_FILE = path.join(DATA_DIR, "request-details.json");

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  return `${model || "unknown"}-${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
}

function initializeDatabase() {
  console.log("[migrate] Opening database:", DB_FILE);
  const db = new Database(DB_FILE);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  console.log("[migrate] Creating schema...");
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
  `);

  db.exec("DROP INDEX IF EXISTS idx_provider_health");

  const existingCols = db.pragma("table_info(request_details)").map(c => c.name);
  if (!existingCols.includes("response_status")) {
    db.exec("ALTER TABLE request_details ADD COLUMN response_status INTEGER");
  }
  if (!existingCols.includes("latency_total")) {
    db.exec("ALTER TABLE request_details ADD COLUMN latency_total REAL");
  }
  if (!existingCols.includes("latency_ttft")) {
    db.exec("ALTER TABLE request_details ADD COLUMN latency_ttft REAL");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_provider_health_v2
      ON request_details(timestamp, provider, model, response_status, latency_total, latency_ttft, status);
  `);

  return db;
}

function migrateLegacyJson(db) {
  if (!fs.existsSync(LEGACY_JSON_FILE)) {
    console.log("[migrate] No legacy JSON file found");
    return 0;
  }

  console.log("[migrate] Reading legacy JSON file...");
  const raw = fs.readFileSync(LEGACY_JSON_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const records = parsed?.records;
  
  if (!Array.isArray(records) || records.length === 0) {
    console.log("[migrate] No records in legacy JSON file");
    fs.renameSync(LEGACY_JSON_FILE, LEGACY_JSON_FILE + ".migrated");
    return 0;
  }

  console.log(`[migrate] Found ${records.length} records to migrate`);

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
  console.log(`[migrate] Successfully migrated ${records.length} records`);
  
  return records.length;
}

async function migrate() {
  console.log("[migrate] Starting request details migration...");
  
  try {
    const db = initializeDatabase();
    const migratedCount = migrateLegacyJson(db);
    
    const count = db.prepare("SELECT COUNT(*) as count FROM request_details").get();
    console.log(`[migrate] Database now contains ${count.count} records`);
    
    const providers = db.prepare("SELECT DISTINCT provider FROM request_details WHERE provider IS NOT NULL").all();
    console.log(`[migrate] Providers in database: ${providers.map(p => p.provider).join(", ")}`);
    
    db.close();
    console.log("[migrate] Migration complete!");
    process.exit(0);
  } catch (err) {
    console.error("[migrate] Migration failed:", err);
    process.exit(1);
  }
}

migrate();
