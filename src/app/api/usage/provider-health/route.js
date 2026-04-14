import { NextResponse } from "next/server";
import { getProviderHealthStats, getTotalRecordCount } from "@/lib/requestDetailsDb";
import { getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

/**
 * GET /api/usage/provider-health
 * Returns success rate and latency stats aggregated per provider.
 * Query params: period (24h | 7d | 30d | 60d | all), provider
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const providerFilter = searchParams.get("provider");

    const periodMs = {
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
      "60d": 60 * 24 * 60 * 60 * 1000,
    };

    const statsFilter = {};
    if (period !== "all" && periodMs[period]) {
      statsFilter.startDate = new Date(Date.now() - periodMs[period]).toISOString();
    }
    if (providerFilter) statsFilter.provider = providerFilter;

    const [rows, totalDbRecords, providerNodes] = await Promise.all([
      getProviderHealthStats(statsFilter),
      getTotalRecordCount(),
      getProviderNodes(),
    ]);

    const nodeMap = {};
    for (const node of providerNodes) {
      nodeMap[node.id] = node.name;
    }

    function resolveProviderName(providerId) {
      if (!providerId) return providerId;
      if (nodeMap[providerId]) return nodeMap[providerId];
      const cfg = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
      return cfg?.name || providerId;
    }

    // Group pre-aggregated SQL rows by provider
    const providerMap = {};
    let totalFilteredRequests = 0;

    for (const row of rows) {
      const id = row.provider || "unknown";
      totalFilteredRequests += row.totalRequests;

      if (!providerMap[id]) {
        providerMap[id] = {
          id,
          name: resolveProviderName(id),
          totalRequests: 0,
          successCount: 0,
          errorCount: 0,
          rateLimitCount: 0,
          latencySum: 0,
          latencyCount: 0,
          ttftSum: 0,
          ttftCount: 0,
          lastUsed: null,
          models: [],
        };
      }

      const p = providerMap[id];
      p.totalRequests += row.totalRequests;
      p.successCount += row.successCount;
      p.errorCount += row.errorCount;
      p.rateLimitCount += row.rateLimitCount;

      if (row.avgLatency != null) {
        p.latencySum += row.avgLatency * row.totalRequests;
        p.latencyCount += row.totalRequests;
      }
      if (row.avgTtft != null) {
        p.ttftSum += row.avgTtft * row.totalRequests;
        p.ttftCount += row.totalRequests;
      }

      if (!p.lastUsed || row.lastUsed > p.lastUsed) {
        p.lastUsed = row.lastUsed;
      }

      p.models.push({
        id: row.model || "unknown",
        totalRequests: row.totalRequests,
        successCount: row.successCount,
        errorCount: row.errorCount,
        rateLimitCount: row.rateLimitCount,
        successRate: row.totalRequests > 0 ? (row.successCount / row.totalRequests) * 100 : 0,
        avgLatency: row.avgLatency != null ? Math.round(row.avgLatency) : 0,
      });
    }

    const providers = Object.values(providerMap)
      .map((p) => ({
        id: p.id,
        name: p.name,
        totalRequests: p.totalRequests,
        successCount: p.successCount,
        errorCount: p.errorCount,
        rateLimitCount: p.rateLimitCount,
        successRate: p.totalRequests > 0 ? (p.successCount / p.totalRequests) * 100 : 0,
        avgLatency: p.latencyCount > 0 ? Math.round(p.latencySum / p.latencyCount) : 0,
        avgTtft: p.ttftCount > 0 ? Math.round(p.ttftSum / p.ttftCount) : 0,
        lastUsed: p.lastUsed,
        models: p.models.sort((a, b) => b.totalRequests - a.totalRequests),
      }))
      .sort((a, b) => b.totalRequests - a.totalRequests);

    const totalRequests = providers.reduce((s, p) => s + p.totalRequests, 0);
    const totalSuccess = providers.reduce((s, p) => s + p.successCount, 0);

    return NextResponse.json({
      providers,
      summary: {
        totalRequests,
        overallSuccessRate: totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : 0,
        totalProviders: providers.length,
        recordCount: totalFilteredRequests,
        totalDbRecords,
        period,
      },
    });
  } catch (error) {
    console.error("[API] Failed to get provider health:", error);
    return NextResponse.json(
      { error: "Failed to fetch provider health" },
      { status: 500 }
    );
  }
}
