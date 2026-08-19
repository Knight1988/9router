import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-performance-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();

  await db.saveRequestUsage({
    provider: "openai",
    model: "gpt-4o-mini",
    connectionId: "performance-test",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    endpoint: "/v1/chat/completions",
    status: "ok",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usage dashboard performance", () => {
  it("coalesces concurrent usage stats cache misses by period", async () => {
    global._usageStatsCache.clear();
    global._usageStatsInflight.clear();
    const originalAll = adapter.all.bind(adapter);
    let historyQueries = 0;
    adapter.all = (sql, params) => {
      if (sql.includes("FROM usageHistory")) historyQueries += 1;
      return originalAll(sql, params);
    };

    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => db.getUsageStats("24h"))
      );
      expect(results.every((result) => result.totalRequests === 1)).toBe(true);
      expect(historyQueries).toBe(3);
    } finally {
      adapter.all = originalAll;
    }
  });

  it("coalesces concurrent chart cache misses by period", async () => {
    global._chartDataCache.clear();
    global._chartDataInflight.clear();
    const originalAll = adapter.all.bind(adapter);
    let chartQueries = 0;
    adapter.all = (sql, params) => {
      if (sql.includes("FROM usageHistory") && sql.includes("promptTokens")) chartQueries += 1;
      return originalAll(sql, params);
    };

    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => db.getChartData("today"))
      );
      expect(results).toHaveLength(10);
      expect(results[0]).toHaveLength(24);
      expect(chartQueries).toBe(1);
    } finally {
      adapter.all = originalAll;
    }
  });

  it("disables automatic prefetch for every sidebar route", () => {
    const sidebar = fs.readFileSync(
      path.join(repoRoot, "src/shared/components/Sidebar.js"),
      "utf8"
    );
    const links = sidebar.match(/<Link\b[\s\S]*?>/g) || [];

    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.includes("prefetch={false}"))).toBe(true);
  });
});
