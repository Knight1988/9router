import { getAdapter } from "../driver.js";

const RETENTION_DAYS = 60;

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localDayBoundsAsIso(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function todayLocalDateKey() {
  return getLocalDateKey(new Date());
}

function dateKeyFromDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return getLocalDateKey(d);
}

export async function aggregateRequestDetailsForDate(dateKey) {
  const db = await getAdapter();
  const { startIso, endIso } = localDayBoundsAsIso(dateKey);

  const rows = db.all(
    `SELECT provider, model, status,
       json_extract(data, '$.latency.total') AS lat,
       json_extract(data, '$.latency.ttft') AS ttft,
       timestamp
     FROM requestDetails
     WHERE timestamp >= ? AND timestamp < ?`,
    [startIso, endIso]
  );

  if (rows.length === 0) return { dateKey, groupCount: 0, deletedRows: 0 };

  const groups = {};
  for (const r of rows) {
    const key = `${r.provider || ""}|${r.model || ""}`;
    if (!groups[key]) {
      groups[key] = {
        provider: r.provider || "",
        model: r.model || "",
        totalRequests: 0,
        successCount: 0,
        errorCount: 0,
        rateLimitCount: 0,
        latencySum: 0,
        latencyCount: 0,
        ttftSum: 0,
        ttftCount: 0,
        firstSeen: r.timestamp,
        lastUsed: r.timestamp,
      };
    }
    const g = groups[key];
    g.totalRequests++;
    if (r.status === "success") g.successCount++;
    else g.errorCount++;
    const lat = parseFloat(r.lat);
    if (lat > 0) { g.latencySum += lat; g.latencyCount++; }
    const ttft = parseFloat(r.ttft);
    if (ttft > 0) { g.ttftSum += ttft; g.ttftCount++; }
    if (r.timestamp < g.firstSeen) g.firstSeen = r.timestamp;
    if (r.timestamp > g.lastUsed) g.lastUsed = r.timestamp;
  }

  const groupCount = Object.keys(groups).length;

  db.transaction(() => {
    for (const g of Object.values(groups)) {
      db.run(
        `INSERT INTO providerHealthDaily
           (dateKey, provider, model, totalRequests, successCount, errorCount, rateLimitCount,
            latencySum, latencyCount, ttftSum, ttftCount, firstSeen, lastUsed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dateKey, provider, model) DO UPDATE SET
           totalRequests = excluded.totalRequests,
           successCount  = excluded.successCount,
           errorCount    = excluded.errorCount,
           rateLimitCount = excluded.rateLimitCount,
           latencySum    = excluded.latencySum,
           latencyCount  = excluded.latencyCount,
           ttftSum       = excluded.ttftSum,
           ttftCount     = excluded.ttftCount,
           firstSeen     = MIN(providerHealthDaily.firstSeen, excluded.firstSeen),
           lastUsed      = MAX(providerHealthDaily.lastUsed, excluded.lastUsed)`,
        [
          dateKey, g.provider, g.model,
          g.totalRequests, g.successCount, g.errorCount, g.rateLimitCount,
          g.latencySum, g.latencyCount, g.ttftSum, g.ttftCount,
          g.firstSeen, g.lastUsed,
        ]
      );
    }
    db.run(
      `DELETE FROM requestDetails WHERE timestamp >= ? AND timestamp < ?`,
      [startIso, endIso]
    );
  });

  return { dateKey, groupCount, deletedRows: rows.length };
}

export async function aggregateBackfill() {
  const db = await getAdapter();
  const today = todayLocalDateKey();

  // Start of local today in UTC (used as cutoff for raw rows)
  const [ty, tm, td] = today.split("-").map(Number);
  const startOfLocalTodayIso = new Date(ty, tm - 1, td, 0, 0, 0, 0).toISOString();

  // Gather distinct local dateKeys present in requestDetails (before today)
  const rawRows = db.all(
    `SELECT timestamp FROM requestDetails WHERE timestamp < ?`,
    [startOfLocalTodayIso]
  );

  const daySet = new Set();
  for (const r of rawRows) {
    daySet.add(getLocalDateKey(r.timestamp));
  }
  const uniqueDays = [...daySet].filter((dk) => dk < today).sort();

  const results = [];
  for (const dateKey of uniqueDays) {
    try {
      const r = await aggregateRequestDetailsForDate(dateKey);
      results.push(r);
      console.log(`[HealthAggregator] aggregated ${dateKey}: ${r.deletedRows} rows → ${r.groupCount} groups`);
    } catch (e) {
      console.error(`[HealthAggregator] failed for ${dateKey}:`, e.message);
    }
  }

  const cutoffKey = dateKeyFromDaysAgo(RETENTION_DAYS);
  const delResult = db.run(
    `DELETE FROM providerHealthDaily WHERE dateKey < ?`,
    [cutoffKey]
  );
  const daysDeleted = delResult?.changes ?? 0;

  if (daysDeleted > 0) {
    console.log(`[HealthAggregator] pruned ${daysDeleted} day-rows older than ${cutoffKey}`);
  }

  const { invalidateHealthCache, invalidateCountCache } = await import("./requestDetailsRepo.js");
  invalidateHealthCache();
  invalidateCountCache();

  return { daysAggregated: results.length, daysDeleted, details: results };
}

export async function getDailyHealthRows({ startDateKey, provider } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (startDateKey) { conds.push("dateKey >= ?"); params.push(startDateKey); }
  if (provider) { conds.push("provider = ?"); params.push(provider); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const rows = db.all(
    `SELECT provider, model,
       SUM(totalRequests) AS totalRequests,
       SUM(successCount) AS successCount,
       SUM(errorCount) AS errorCount,
       SUM(rateLimitCount) AS rateLimitCount,
       SUM(latencySum) AS latencySum,
       SUM(latencyCount) AS latencyCount,
       SUM(ttftSum) AS ttftSum,
       SUM(ttftCount) AS ttftCount,
       MIN(firstSeen) AS firstSeen,
       MAX(lastUsed) AS lastUsed
     FROM providerHealthDaily ${where}
     GROUP BY provider, model`,
    params
  );

  return rows.map((r) => ({
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
  }));
}
