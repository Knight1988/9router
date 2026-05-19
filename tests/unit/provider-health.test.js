/**
 * Unit tests for /api/usage/provider-health route
 *
 * Covers:
 *  - Period → startDate mapping
 *  - Cache-Control TTL per period
 *  - Provider/model aggregation (weighted averages, sums, sorting)
 *  - Provider name resolution priority
 *  - Summary block correctness
 *  - Error path → 500
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/requestDetailsDb", () => ({
  getProviderHealthStats: vi.fn(),
  getTotalRecordCount: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderNodes: vi.fn(),
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    openai: { name: "OpenAI" },
    anthropic: { name: "Anthropic" },
  },
  getProviderByAlias: vi.fn(),
}));

import { getProviderHealthStats, getTotalRecordCount } from "../../src/lib/requestDetailsDb.js";
import { getProviderNodes } from "../../src/lib/localDb.js";
import { getProviderByAlias } from "../../src/shared/constants/providers.js";
import { GET } from "../../src/app/api/usage/provider-health/route.js";

function makeRequest(search = "") {
  return new Request(`http://x/api/usage/provider-health${search ? "?" + search : ""}`);
}

async function callGET(search = "") {
  const req = makeRequest(search);
  const res = await GET(req);
  const body = await res.json();
  return { res, body };
}

function row(overrides) {
  return {
    provider: "openai",
    model: "gpt-4",
    totalRequests: 10,
    successCount: 8,
    errorCount: 2,
    rateLimitCount: 0,
    lastUsed: "2024-06-01T10:00:00.000Z",
    avgLatency: 500,
    avgTtft: 200,
    ...overrides,
  };
}

describe("provider-health route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderNodes.mockResolvedValue([]);
    getTotalRecordCount.mockResolvedValue(0);
    getProviderByAlias.mockReturnValue(null);
  });

  // -------------------------------------------------------------------------
  // Period → startDate mapping
  // -------------------------------------------------------------------------

  describe("period → startDate mapping", () => {
    const periods = {
      "10m": 10 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "5h": 5 * 60 * 60 * 1000,
      "12h": 12 * 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
      "60d": 60 * 24 * 60 * 60 * 1000,
    };

    for (const [period, expectedMs] of Object.entries(periods)) {
      it(`period=${period} passes startDate ~${expectedMs}ms ago`, async () => {
        getProviderHealthStats.mockResolvedValue([]);
        const before = Date.now();
        await callGET(`period=${period}`);
        const after = Date.now();

        const call = getProviderHealthStats.mock.calls[0][0];
        expect(call.startDate).toBeDefined();
        const startMs = new Date(call.startDate).getTime();
        expect(before - startMs).toBeGreaterThanOrEqual(expectedMs - 100);
        expect(after - startMs).toBeLessThanOrEqual(expectedMs + 1000);
      });
    }

    it("period=all omits startDate", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      await callGET("period=all");
      const call = getProviderHealthStats.mock.calls[0][0];
      expect(call.startDate).toBeUndefined();
    });

    it("unknown period omits startDate (fallback behavior)", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      await callGET("period=bogus");
      const call = getProviderHealthStats.mock.calls[0][0];
      expect(call.startDate).toBeUndefined();
    });

    it("defaults to 7d when period is absent", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      const before = Date.now();
      await callGET("");
      const after = Date.now();
      const call = getProviderHealthStats.mock.calls[0][0];
      expect(call.startDate).toBeDefined();
      const startMs = new Date(call.startDate).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(before - startMs).toBeGreaterThanOrEqual(sevenDaysMs - 100);
      expect(after - startMs).toBeLessThanOrEqual(sevenDaysMs + 1000);
    });

    it("forwards provider filter to getProviderHealthStats", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      await callGET("provider=openai&period=1h");
      const call = getProviderHealthStats.mock.calls[0][0];
      expect(call.provider).toBe("openai");
    });
  });

  // -------------------------------------------------------------------------
  // Cache-Control TTL
  // -------------------------------------------------------------------------

  describe("Cache-Control TTL", () => {
    const shortPeriods = ["10m", "1h", "5h"];
    const longPeriods = ["12h", "24h", "7d", "30d", "60d", "all"];

    for (const p of shortPeriods) {
      it(`period=${p} → max-age=30`, async () => {
        getProviderHealthStats.mockResolvedValue([]);
        const { res } = await callGET(`period=${p}`);
        expect(res.headers.get("Cache-Control")).toContain("max-age=30");
      });
    }

    for (const p of longPeriods) {
      it(`period=${p} → max-age=120`, async () => {
        getProviderHealthStats.mockResolvedValue([]);
        const { res } = await callGET(`period=${p}`);
        expect(res.headers.get("Cache-Control")).toContain("max-age=120");
      });
    }

    it("unknown period → max-age=120", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      const { res } = await callGET("period=bogus");
      expect(res.headers.get("Cache-Control")).toContain("max-age=120");
    });
  });

  // -------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------

  describe("aggregation", () => {
    it("sums totalRequests / successCount / errorCount / rateLimitCount per provider", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ model: "gpt-4", totalRequests: 10, successCount: 8, errorCount: 2, rateLimitCount: 1 }),
        row({ model: "gpt-3.5", totalRequests: 20, successCount: 15, errorCount: 5, rateLimitCount: 2 }),
      ]);
      const { body } = await callGET("period=all");
      const p = body.providers[0];
      expect(p.totalRequests).toBe(30);
      expect(p.successCount).toBe(23);
      expect(p.errorCount).toBe(7);
      expect(p.rateLimitCount).toBe(3);
    });

    it("computes successRate as (successCount / totalRequests) * 100", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ totalRequests: 100, successCount: 75, errorCount: 25 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].successRate).toBeCloseTo(75, 1);
    });

    it("successRate is 0 when totalRequests is 0", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ totalRequests: 0, successCount: 0, errorCount: 0 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].successRate).toBe(0);
    });

    it("computes request-weighted avgLatency and rounds it", async () => {
      // (500*10 + 1000*10) / 20 = 750
      getProviderHealthStats.mockResolvedValue([
        row({ model: "m1", totalRequests: 10, avgLatency: 500 }),
        row({ model: "m2", totalRequests: 10, avgLatency: 1000 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].avgLatency).toBe(750);
    });

    it("avgLatency is 0 when all avgLatency values are null", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ totalRequests: 5, avgLatency: null }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].avgLatency).toBe(0);
    });

    it("computes request-weighted avgTtft and rounds it", async () => {
      // (200*10 + 400*10) / 20 = 300
      getProviderHealthStats.mockResolvedValue([
        row({ model: "m1", totalRequests: 10, avgTtft: 200 }),
        row({ model: "m2", totalRequests: 10, avgTtft: 400 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].avgTtft).toBe(300);
    });

    it("avgTtft is 0 when all avgTtft values are null", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ totalRequests: 5, avgTtft: null }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].avgTtft).toBe(0);
    });

    it("lastUsed is max ISO timestamp across all rows for provider", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ model: "m1", lastUsed: "2024-01-01T00:00:00.000Z" }),
        row({ model: "m2", lastUsed: "2024-06-15T12:00:00.000Z" }),
        row({ model: "m3", lastUsed: "2024-03-10T08:00:00.000Z" }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].lastUsed).toBe("2024-06-15T12:00:00.000Z");
    });

    it("models are sorted descending by totalRequests", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ model: "small", totalRequests: 5 }),
        row({ model: "large", totalRequests: 50 }),
        row({ model: "medium", totalRequests: 20 }),
      ]);
      const { body } = await callGET("period=all");
      const models = body.providers[0].models.map((m) => m.id);
      expect(models).toEqual(["large", "medium", "small"]);
    });

    it("each model has successRate and avgLatency", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ model: "m1", totalRequests: 10, successCount: 9, avgLatency: 300 }),
      ]);
      const { body } = await callGET("period=all");
      const m = body.providers[0].models[0];
      expect(m.successRate).toBeCloseTo(90, 1);
      expect(m.avgLatency).toBe(300);
    });

    it("providers are sorted descending by totalRequests", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ provider: "openai", model: "m", totalRequests: 5 }),
        row({ provider: "anthropic", model: "m", totalRequests: 50 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].id).toBe("anthropic");
      expect(body.providers[1].id).toBe("openai");
    });
  });

  // -------------------------------------------------------------------------
  // Name resolution
  // -------------------------------------------------------------------------

  describe("name resolution", () => {
    it("uses provider node name when available", async () => {
      getProviderNodes.mockResolvedValue([{ id: "openai", name: "My OpenAI Node" }]);
      getProviderHealthStats.mockResolvedValue([row({ provider: "openai" })]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].name).toBe("My OpenAI Node");
    });

    it("falls back to getProviderByAlias when no node match", async () => {
      getProviderByAlias.mockReturnValue({ name: "Alias Provider" });
      getProviderHealthStats.mockResolvedValue([row({ provider: "alias-id" })]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].name).toBe("Alias Provider");
    });

    it("falls back to AI_PROVIDERS[id].name", async () => {
      getProviderByAlias.mockReturnValue(null);
      getProviderHealthStats.mockResolvedValue([row({ provider: "anthropic" })]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].name).toBe("Anthropic");
    });

    it("falls back to raw providerId when nothing matches", async () => {
      getProviderByAlias.mockReturnValue(null);
      getProviderHealthStats.mockResolvedValue([row({ provider: "unknown-provider" })]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].name).toBe("unknown-provider");
    });

    it("maps null provider to id='unknown'", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ provider: null, totalRequests: 3 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.providers[0].id).toBe("unknown");
    });
  });

  // -------------------------------------------------------------------------
  // Summary block
  // -------------------------------------------------------------------------

  describe("summary block", () => {
    it("totalRequests sums across all providers", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ provider: "openai", totalRequests: 30, successCount: 20 }),
        row({ provider: "anthropic", totalRequests: 10, successCount: 8 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.summary.totalRequests).toBe(40);
    });

    it("overallSuccessRate = total success / total requests * 100", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ provider: "openai", totalRequests: 100, successCount: 80 }),
        row({ provider: "anthropic", totalRequests: 100, successCount: 60 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.summary.overallSuccessRate).toBeCloseTo(70, 1);
    });

    it("overallSuccessRate is 0 when no requests", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      const { body } = await callGET("period=all");
      expect(body.summary.overallSuccessRate).toBe(0);
    });

    it("totalProviders reflects distinct provider count", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ provider: "openai" }),
        row({ provider: "anthropic" }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.summary.totalProviders).toBe(2);
    });

    it("recordCount equals sum of input row totalRequests", async () => {
      getProviderHealthStats.mockResolvedValue([
        row({ provider: "openai", totalRequests: 7 }),
        row({ provider: "anthropic", totalRequests: 13 }),
      ]);
      const { body } = await callGET("period=all");
      expect(body.summary.recordCount).toBe(20);
    });

    it("totalDbRecords passes through getTotalRecordCount value", async () => {
      getTotalRecordCount.mockResolvedValue(9999);
      getProviderHealthStats.mockResolvedValue([]);
      const { body } = await callGET("period=all");
      expect(body.summary.totalDbRecords).toBe(9999);
    });

    it("echoes period back in summary", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      const { body } = await callGET("period=30d");
      expect(body.summary.period).toBe("30d");
    });
  });

  // -------------------------------------------------------------------------
  // Error path
  // -------------------------------------------------------------------------

  describe("error path", () => {
    it("returns 500 when getProviderHealthStats throws", async () => {
      getProviderHealthStats.mockRejectedValue(new Error("db down"));
      const { res, body } = await callGET("period=7d");
      expect(res.status).toBe(500);
      expect(body.error).toBeDefined();
    });

    it("returns 500 when getTotalRecordCount throws", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      getTotalRecordCount.mockRejectedValue(new Error("count fail"));
      const { res, body } = await callGET("period=7d");
      expect(res.status).toBe(500);
      expect(body.error).toBeDefined();
    });

    it("returns 500 when getProviderNodes throws", async () => {
      getProviderHealthStats.mockResolvedValue([]);
      getTotalRecordCount.mockResolvedValue(0);
      getProviderNodes.mockRejectedValue(new Error("nodes fail"));
      const { res, body } = await callGET("period=7d");
      expect(res.status).toBe(500);
      expect(body.error).toBeDefined();
    });
  });
});
