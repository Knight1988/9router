# 9Router Database Design

_Last updated: 2026-05-22_

## Executive Summary

9Router uses SQLite as its primary persistence layer, storing configuration, provider connections, usage statistics, and observability data. The database design prioritizes:

- **Transactional integrity** for concurrent OAuth token refresh and account selection
- **Performance** through strategic indexing and denormalized daily aggregates
- **Flexibility** via hybrid schema (normalized columns + JSON blobs)
- **Migration safety** with versioned migrations and automatic legacy JSON import

## Database Technology Stack

- **Engine**: SQLite 3 (via better-sqlite3, node:sqlite, or sql.js fallback)
- **Location**: `${DATA_DIR}/db/data.sqlite` (default: `~/.9router/db/data.sqlite`)
- **Journal Mode**: WAL (Write-Ahead Logging)
- **Foreign Keys**: Enabled
- **Backup Strategy**: Automatic backups on schema/app version upgrades

## Schema Version Management

Current schema version: **1**

- **Versioned migrations**: `src/lib/db/migrations/*.js` (destructive changes)
- **Additive sync**: `src/lib/db/schema.js` TABLES declaration (auto-add missing columns/indexes)
- **Legacy import**: One-time JSON → SQLite migration on fresh DB

## Core Tables

### 1. `_meta` — System Metadata

Stores internal system state and counters.

```sql
CREATE TABLE _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Key entries:**
- `schemaVersion`: Current migration version (integer)
- `appVersion`: Application version that last touched the DB
- `migratedAt`: ISO timestamp of legacy JSON import
- `totalRequestsLifetime`: Atomic request counter (incremented in usage transaction)

**Access pattern**: Direct key-value lookups via `metaStore.js` helper

---

### 2. `settings` — Global Application Settings

Single-row table storing all application configuration as JSON.

```sql
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL  -- JSON blob
);
```

**JSON schema** (see `settingsRepo.js` DEFAULT_SETTINGS):
```json
{
  "cloudEnabled": false,
  "tunnelEnabled": false,
  "stickyRoundRobinLimit": 3,
  "providerStrategies": {},
  "comboStrategy": "fallback",
  "requireLogin": true,
  "authMode": "password",
  "enableObservability": true,
  "observabilityMaxRecords": 1000,
  "rtkEnabled": true,
  "cavemanEnabled": false,
  "smartRoutingIntervalMinutes": 15
}
```

**Concurrency**: Atomic read-merge-write inside transaction (prevents lost updates)

**Access**: `getSettings()`, `updateSettings(partial)`

---

### 3. `providerConnections` — OAuth & API Key Accounts

Stores authenticated provider accounts (OAuth tokens, API keys).

```sql
CREATE TABLE providerConnections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  authType TEXT NOT NULL,  -- 'oauth' | 'apikey'
  name TEXT,
  email TEXT,
  priority INTEGER,
  isActive INTEGER DEFAULT 1,
  data TEXT NOT NULL,  -- JSON blob with tokens/secrets
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX idx_pc_provider ON providerConnections(provider);
CREATE INDEX idx_pc_provider_active ON providerConnections(provider, isActive);
CREATE INDEX idx_pc_priority ON providerConnections(provider, priority);
```

**Normalized columns:**
- `provider`: Provider ID (e.g., `claude-code`, `codex`, `glm`)
- `authType`: Authentication method
- `name`: Display name (for API keys) or derived from email
- `email`: OAuth account email (for deduplication)
- `priority`: Sort order within provider (auto-assigned, reordered on CRUD)
- `isActive`: Soft-delete flag

**JSON `data` blob** (provider-specific):
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": "2026-05-22T12:00:00Z",
  "apiKey": "...",
  "testStatus": "success",
  "lastError": "...",
  "rateLimitedUntil": "...",
  "consecutiveUseCount": 0,
  "providerSpecificData": {}
}
```

**Critical operations:**
- **OAuth refresh**: Atomic token update inside transaction (prevents race conditions)
- **Account selection**: Priority-sorted query with `isActive=1` filter
- **Deduplication**: OAuth accounts matched by `email`, API keys by `name`
- **Reordering**: Automatic priority reassignment on create/delete

**Access**: `connectionsRepo.js`

---

### 4. `providerNodes` — Custom Compatible Endpoints

User-defined OpenAI/Anthropic-compatible provider nodes.

```sql
CREATE TABLE providerNodes (
  id TEXT PRIMARY KEY,
  type TEXT,  -- 'openai-compatible' | 'anthropic-compatible'
  name TEXT,
  data TEXT NOT NULL,  -- JSON blob
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX idx_pn_type ON providerNodes(type);
```

**JSON `data` blob:**
```json
{
  "prefix": "custom",
  "apiType": "openai",
  "baseUrl": "https://api.example.com/v1"
}
```

**Access**: `nodesRepo.js`

---

### 5. `proxyPools` — Outbound Proxy Configuration

HTTP/SOCKS proxy pools for upstream provider calls.

```sql
CREATE TABLE proxyPools (
  id TEXT PRIMARY KEY,
  isActive INTEGER DEFAULT 1,
  testStatus TEXT,
  data TEXT NOT NULL,  -- JSON blob
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX idx_pp_active ON proxyPools(isActive);
CREATE INDEX idx_pp_status ON proxyPools(testStatus);
```

**JSON `data` blob:**
```json
{
  "name": "Proxy 1",
  "proxyUrl": "http://proxy.example.com:8080",
  "noProxy": "localhost,127.0.0.1",
  "type": "http",
  "strictProxy": false,
  "lastTestedAt": "...",
  "lastError": null
}
```

**Access**: `proxyPoolsRepo.js`

---

### 6. `apiKeys` — Local API Keys

Generated API keys for `/v1/*` endpoint authentication.

```sql
CREATE TABLE apiKeys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT,
  machineId TEXT,
  isActive INTEGER DEFAULT 1,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_ak_key ON apiKeys(key);
```

**Key generation**: HMAC-based with `API_KEY_SECRET` and `machineId`

**Validation**: Fast lookup by `key` with `isActive` check

**Access**: `apiKeysRepo.js`

---

### 7. `combos` — Model Fallback Chains

User-defined model sequences for automatic fallback.

```sql
CREATE TABLE combos (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT,  -- 'fallback' | 'round-robin' | 'sticky-round-robin'
  models TEXT NOT NULL,  -- JSON array
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX idx_combo_name ON combos(name);
```

**JSON `models` array:**
```json
["cc/claude-opus-4-7", "glm/glm-5.1", "kr/claude-sonnet-4.5"]
```

**Lookup**: By `name` (used as model string in requests)

**Access**: `combosRepo.js`

---

### 8. `kv` — Generic Key-Value Store

Multi-scope key-value table for flexible schema-less data.

```sql
CREATE TABLE kv (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,  -- JSON blob
  PRIMARY KEY (scope, key)
);

CREATE INDEX idx_kv_scope ON kv(scope);
```

**Scopes:**
- `modelAliases`: Model name aliases (e.g., `gpt-4` → `openai/gpt-4`)
- `customModels`: User-added models (key: `${provider}|${id}|${type}`)
- `mitmAlias`: MITM router model mappings per CLI tool
- `pricing`: Custom pricing overrides per provider
- `disabledModels`: Disabled model IDs per provider

**Access**: Scope-specific helpers in `aliasRepo.js`, `pricingRepo.js`, `disabledModelsRepo.js`

---

## Usage & Observability Tables

### 9. `usageHistory` — Request-Level Usage Log

Append-only log of every API request with token counts and cost.

```sql
CREATE TABLE usageHistory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  connectionId TEXT,
  apiKey TEXT,
  endpoint TEXT,
  promptTokens INTEGER DEFAULT 0,
  completionTokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  status TEXT,
  tokens TEXT,  -- JSON blob with detailed token breakdown
  meta TEXT     -- JSON blob for future extensions
);

CREATE INDEX idx_uh_ts ON usageHistory(timestamp DESC);
CREATE INDEX idx_uh_provider ON usageHistory(provider);
CREATE INDEX idx_uh_model ON usageHistory(model);
CREATE INDEX idx_uh_conn ON usageHistory(connectionId);
```

**Write pattern**: Single INSERT per request (no updates)

**Cost calculation**: Computed from `tokens` JSON + pricing table before insert

**JSON `tokens` blob:**
```json
{
  "prompt_tokens": 1000,
  "completion_tokens": 500,
  "cached_tokens": 200,
  "reasoning_tokens": 0,
  "cache_creation_input_tokens": 0
}
```

**Retention**: Unlimited (user-managed via dashboard)

**Access**: `usageRepo.js`

---

### 10. `usageDaily` — Pre-Aggregated Daily Stats

Denormalized daily rollups for fast dashboard queries.

```sql
CREATE TABLE usageDaily (
  dateKey TEXT PRIMARY KEY,  -- 'YYYY-MM-DD'
  data TEXT NOT NULL  -- JSON blob
);
```

**JSON `data` structure:**
```json
{
  "requests": 100,
  "promptTokens": 50000,
  "completionTokens": 25000,
  "cost": 0.15,
  "byProvider": {
    "claude-code": { "requests": 50, "promptTokens": 30000, ... }
  },
  "byModel": {
    "claude-opus-4-7|claude-code": { "requests": 50, "rawModel": "claude-opus-4-7", ... }
  },
  "byAccount": {
    "conn-id-123": { "requests": 50, "rawModel": "...", "provider": "...", ... }
  },
  "byApiKey": {
    "sk_xxx|model|provider": { "requests": 50, "apiKey": "sk_xxx", ... }
  },
  "byEndpoint": {
    "/v1/chat/completions|model|provider": { "requests": 50, "endpoint": "/v1/chat/completions", ... }
  }
}
```

**Update pattern**: Atomic read-merge-write inside same transaction as `usageHistory` INSERT

**Query optimization**: Single row read per day (vs. scanning thousands of history rows)

**Access**: `usageRepo.js` `getUsageStats()`, `getChartData()`

---

### 11. `requestDetails` — Observability Records

Detailed request/response metadata for debugging and health monitoring.

```sql
CREATE TABLE requestDetails (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  connectionId TEXT,
  status TEXT,
  data TEXT NOT NULL  -- JSON blob
);

CREATE INDEX idx_rd_ts ON requestDetails(timestamp DESC);
CREATE INDEX idx_rd_provider ON requestDetails(provider);
CREATE INDEX idx_rd_model ON requestDetails(model);
CREATE INDEX idx_rd_conn ON requestDetails(connectionId);
```

**JSON `data` blob:**
```json
{
  "requestHeaders": { "content-type": "application/json" },
  "requestBody": { "model": "...", "messages": [...] },
  "responseHeaders": { "x-request-id": "..." },
  "responseBody": { "choices": [...] },
  "latency": { "total": 1234, "ttft": 567 },
  "error": null
}
```

**Sensitive data**: Authorization headers stripped before storage

**Size limits**: JSON fields truncated if exceeding `observabilityMaxJsonSize` (default 5KB)

**Write pattern**: Batched writes (buffer flushed every 5s or 20 records)

**Retention**: Auto-pruned to `observabilityMaxRecords` (default 1000)

**Access**: `requestDetailsRepo.js`

---

### 12. `providerHealthDaily` — Aggregated Health Metrics

Daily provider/model health statistics derived from `requestDetails`.

```sql
CREATE TABLE providerHealthDaily (
  dateKey TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  totalRequests INTEGER DEFAULT 0,
  successCount INTEGER DEFAULT 0,
  errorCount INTEGER DEFAULT 0,
  rateLimitCount INTEGER DEFAULT 0,
  latencySum REAL DEFAULT 0,
  latencyCount INTEGER DEFAULT 0,
  ttftSum REAL DEFAULT 0,
  ttftCount INTEGER DEFAULT 0,
  firstSeen TEXT,
  lastUsed TEXT,
  PRIMARY KEY (dateKey, provider, model)
);

CREATE INDEX idx_phd_date ON providerHealthDaily(dateKey);
CREATE INDEX idx_phd_provider ON providerHealthDaily(provider);
```

**Aggregation**: Background job processes `requestDetails` → daily rollups

**Metrics**:
- Success/error/rate-limit counts
- Average latency (total and time-to-first-token)
- First seen / last used timestamps

**Retention**: 60 days (configurable)

**Access**: `providerHealthRepo.js`

---

## Data Flow Diagrams

### Request Lifecycle → Database Writes

```
┌─────────────────────────────────────────────────────────────┐
│ Incoming Request: POST /v1/chat/completions                │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Account Selection (READ)                                │
│    SELECT * FROM providerConnections                        │
│    WHERE provider = ? AND isActive = 1                      │
│    ORDER BY priority ASC                                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Execute Request → Upstream Provider                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Token Refresh (if 401/403) — ATOMIC UPDATE              │
│    BEGIN TRANSACTION;                                       │
│      SELECT * FROM providerConnections WHERE id = ?;        │
│      -- refresh tokens via OAuth --                         │
│      UPDATE providerConnections SET data = ?, updatedAt = ?;│
│    COMMIT;                                                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Usage Tracking — ATOMIC 3-WAY WRITE                     │
│    BEGIN TRANSACTION;                                       │
│      INSERT INTO usageHistory(...);                         │
│      -- read-merge-write usageDaily --                      │
│      UPDATE _meta SET value = value + 1                     │
│        WHERE key = 'totalRequestsLifetime';                 │
│    COMMIT;                                                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Observability (if enabled) — BATCHED WRITE              │
│    -- buffer in memory --                                   │
│    INSERT INTO requestDetails(...);  -- every 5s or 20 recs│
└─────────────────────────────────────────────────────────────┘
```

### Daily Aggregation Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Background Job: Daily Health Aggregation                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Query requestDetails for date range                     │
│    SELECT * FROM requestDetails                             │
│    WHERE timestamp >= ? AND timestamp < ?                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Group by (provider, model) and compute metrics          │
│    - Count success/error/rate-limit                         │
│    - Sum latencies, compute averages                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Upsert into providerHealthDaily                         │
│    INSERT INTO providerHealthDaily(...)                     │
│    ON CONFLICT(dateKey, provider, model)                    │
│    DO UPDATE SET totalRequests = totalRequests + ...       │
└─────────────────────────────────────────────────────────────┘
```

---

## Concurrency & Transaction Patterns

### Critical Sections

1. **OAuth Token Refresh** (`connectionsRepo.js` `updateProviderConnection`)
   - **Problem**: Multiple concurrent requests may trigger refresh simultaneously
   - **Solution**: Atomic read-merge-write inside transaction
   - **Pattern**: `BEGIN; SELECT; UPDATE; COMMIT;`

2. **Usage Tracking** (`usageRepo.js` `saveRequestUsage`)
   - **Problem**: Three writes (history, daily, counter) must be atomic
   - **Solution**: Single transaction wrapping all three operations
   - **Pattern**: `BEGIN; INSERT history; UPSERT daily; UPDATE counter; COMMIT;`

3. **Settings Update** (`settingsRepo.js` `updateSettings`)
   - **Problem**: Concurrent partial updates may lose changes
   - **Solution**: Read-merge-write inside transaction
   - **Pattern**: `BEGIN; SELECT; merge in JS; UPDATE; COMMIT;`

4. **Priority Reordering** (`connectionsRepo.js` `reorderInTx`)
   - **Problem**: Priority gaps after delete
   - **Solution**: Automatic reorder inside transaction
   - **Pattern**: Called within parent transaction (no nested BEGIN)

### Synchronous Transactions (better-sqlite3)

- **No JS yield mid-transaction**: better-sqlite3 is synchronous → no race conditions within same process
- **Multi-process safety**: WAL mode allows concurrent readers, single writer
- **Busy timeout**: 5000ms (prevents immediate SQLITE_BUSY errors)

---

## Performance Optimizations

### Indexing Strategy

**High-cardinality lookups:**
- `providerConnections(provider, isActive)` — account selection hot path
- `usageHistory(timestamp DESC)` — recent logs query
- `requestDetails(timestamp DESC)` — observability dashboard

**Composite indexes:**
- `providerConnections(provider, priority)` — sorted account list
- `providerHealthDaily(dateKey, provider)` — health dashboard filters

### Denormalization

**usageDaily table:**
- **Problem**: Scanning 100K+ `usageHistory` rows for 30-day stats
- **Solution**: Pre-aggregate daily rollups (1 row per day)
- **Trade-off**: Slightly stale (updated on write), but 1000x faster reads

**providerHealthDaily table:**
- **Problem**: Computing health metrics from raw `requestDetails` on every dashboard load
- **Solution**: Background aggregation job (runs daily)
- **Trade-off**: Up to 24h delay, but dashboard loads instantly

### Query Patterns

**Dashboard stats** (`getUsageStats`):
- 7d/30d/60d: Read from `usageDaily` (7-60 rows)
- 24h/today: Scan `usageHistory` with timestamp filter (acceptable for 1-day window)

**Recent logs** (`getRecentLogs`):
- `SELECT ... ORDER BY id DESC LIMIT 200` — fast with `idx_uh_ts`

**Active requests** (in-memory):
- No DB query — tracked in `global._pendingRequests` object

---

## Migration & Versioning

### Schema Evolution

**Versioned migrations** (`src/lib/db/migrations/`):
- Destructive changes (drop column, rename table, type change)
- Each migration has `version`, `name`, `up(db)` function
- Applied sequentially, skip-version safe

**Additive sync** (`schema.js` TABLES):
- Missing tables/columns/indexes auto-added
- Safe for concurrent deploys (no downtime)
- Cannot drop/rename (use versioned migration)

### Legacy JSON Import

**One-time migration** (on fresh DB):
- Reads `~/.9router/db.json`, `usage.json`, `disabledModels.json`, `requestDetails.json`
- Imports into SQLite inside transaction
- Row-count assertion (aborts if mismatch)
- Writes `.migrated-from-json` marker (prevents re-import after wipe)

**Backup strategy**:
- Legacy JSON files kept at `DATA_DIR` (not deleted)
- SQLite backup created before import
- Backup pruning (keeps last 10)

---

## Backup & Recovery

### Automatic Backups

**Triggers**:
- Schema version upgrade
- App version upgrade
- Legacy JSON import

**Location**: `${DATA_DIR}/db/backups/`

**Naming**: `backup-{reason}-{timestamp}/data.sqlite`

**Retention**: Last 10 backups (auto-pruned)

### Manual Backup

```bash
# Copy SQLite file (safe with WAL mode)
cp ~/.9router/db/data.sqlite ~/.9router/db/data.sqlite.backup

# Export to JSON (via dashboard API)
curl http://localhost:20128/api/export > backup.json
```

### Restore

```bash
# From SQLite backup
cp ~/.9router/db/data.sqlite.backup ~/.9router/db/data.sqlite

# From JSON export (via dashboard API)
curl -X POST http://localhost:20128/api/import \
  -H "Content-Type: application/json" \
  -d @backup.json
```

---

## Security Considerations

### Sensitive Data Storage

**Encrypted at rest**: No (relies on filesystem permissions)

**Sensitive fields**:
- `providerConnections.data`: OAuth tokens, API keys, refresh tokens
- `apiKeys.key`: Generated API keys
- `requestDetails.data`: May contain user prompts (PII)

**Mitigation**:
- File permissions: `chmod 600 data.sqlite` (owner read/write only)
- Dashboard auth: JWT cookie + optional OIDC
- API key auth: Optional `REQUIRE_API_KEY=true` for `/v1/*` routes

### Secrets Sanitization

**Request logging**:
- Authorization headers stripped before `requestDetails` insert
- Sensitive header keys: `authorization`, `x-api-key`, `cookie`, `token`

**Export/import**:
- Full export includes all secrets (use with caution)
- Cloud sync: Encrypted in transit (HTTPS), secrets included

---

## Monitoring & Observability

### Database Health Metrics

**Size monitoring**:
```sql
SELECT page_count * page_size / 1024.0 / 1024.0 AS size_mb
FROM pragma_page_count(), pragma_page_size();
```

**Table row counts**:
```sql
SELECT 'usageHistory' AS table_name, COUNT(*) AS rows FROM usageHistory
UNION ALL
SELECT 'requestDetails', COUNT(*) FROM requestDetails;
```

**WAL checkpoint status**:
```sql
PRAGMA wal_checkpoint(TRUNCATE);
```

### Performance Profiling

**Slow query log**: Not built-in (add via `better-sqlite3` verbose mode)

**Index usage**:
```sql
EXPLAIN QUERY PLAN
SELECT * FROM providerConnections WHERE provider = ? AND isActive = 1;
```

---

## Future Enhancements

### Potential Improvements

1. **Partitioning**: Split `usageHistory` by month (reduce table size)
2. **Compression**: Compress old `requestDetails` JSON blobs
3. **Read replicas**: Export to read-only SQLite for analytics
4. **Encryption**: Add SQLCipher for at-rest encryption
5. **Audit log**: Track all CRUD operations on `providerConnections`

### Schema Evolution Roadmap

**Version 2** (planned):
- Add `usageHistory.cached_tokens` column (currently in JSON)
- Add `providerConnections.lastUsedAt` column (for LRU selection)
- Add `requestDetails.errorCode` column (for faster error filtering)

---

## Appendix: Table Summary

| Table | Rows (typical) | Write Pattern | Read Pattern | Indexes |
|-------|----------------|---------------|--------------|---------|
| `_meta` | <10 | Rare | Frequent | PK only |
| `settings` | 1 | Rare | Frequent | PK only |
| `providerConnections` | 10-50 | Moderate | Very frequent | 3 indexes |
| `providerNodes` | 0-10 | Rare | Moderate | 1 index |
| `proxyPools` | 0-5 | Rare | Moderate | 2 indexes |
| `apiKeys` | 1-10 | Rare | Frequent | 2 indexes |
| `combos` | 5-20 | Rare | Frequent | 1 index |
| `kv` | 50-200 | Moderate | Frequent | 1 index |
| `usageHistory` | 10K-1M+ | Very frequent | Moderate | 4 indexes |
| `usageDaily` | 30-365 | Frequent | Very frequent | PK only |
| `requestDetails` | 200-1000 | Frequent (batched) | Moderate | 4 indexes |
| `providerHealthDaily` | 100-1000 | Daily (background) | Moderate | 2 indexes |

---

## References

- **Schema definition**: `src/lib/db/schema.js`
- **Migration runner**: `src/lib/db/migrate.js`
- **Repository layer**: `src/lib/db/repos/*.js`
- **Adapter abstraction**: `src/lib/db/driver.js`, `src/lib/db/adapters/*.js`
- **Architecture doc**: `docs/ARCHITECTURE.md`
