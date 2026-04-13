import { NextResponse } from "next/server";
import { getRequestDetails, getTotalRecordCount } from "@/lib/requestDetailsDb";
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

    // Build SQL-level time filter to avoid loading unnecessary records
    const periodMs = {
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
      "60d": 60 * 24 * 60 * 60 * 1000,
    };

    const dbFilter = { pageSize: 100000 };
    if (period !== "all" && periodMs[period]) {
      dbFilter.startDate = new Date(Date.now() - periodMs[period]).toISOString();
    }
    if (providerFilter) dbFilter.provider = providerFilter;

    const [{ details: filtered }, totalDbRecords] = await Promise.all([
      getRequestDetails(dbFilter),
      getTotalRecordCount(),
    ]);

    // Resolve provider display names
    const providerNodes = await getProviderNodes();
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

    // Group records by provider
    const providerMap = {};
    for (const record of filtered) {
      const id = record.provider || "unknown";
      if (!providerMap[id]) {
        providerMap[id] = {
          id,
          name: resolveProviderName(id),
          totalRequests: 0,
          successCount: 0,
          errorCount: 0,
          latencyTotalSum: 0,
          latencyTotalCount: 0,
          ttftSum: 0,
          ttftCount: 0,
          lastUsed: null,
          models: {},
        };
      }

      const p = providerMap[id];
      p.totalRequests++;

      if (record.status === "success") {
        p.successCount++;
      } else {
        p.errorCount++;
      }

      if (record.latency?.total > 0) {
        p.latencyTotalSum += record.latency.total;
        p.latencyTotalCount++;
      }

      if (record.latency?.ttft > 0) {
        p.ttftSum += record.latency.ttft;
        p.ttftCount++;
      }

      if (!p.lastUsed || new Date(record.timestamp) > new Date(p.lastUsed)) {
        p.lastUsed = record.timestamp;
      }

      // Per-model breakdown
      const modelId = record.model || "unknown";
      if (!p.models[modelId]) {
        p.models[modelId] = {
          id: modelId,
          totalRequests: 0,
          successCount: 0,
          errorCount: 0,
          latencyTotalSum: 0,
          latencyTotalCount: 0,
        };
      }
      const m = p.models[modelId];
      m.totalRequests++;
      if (record.status === "success") {
        m.successCount++;
      } else {
        m.errorCount++;
      }
      if (record.latency?.total > 0) {
        m.latencyTotalSum += record.latency.total;
        m.latencyTotalCount++;
      }
    }

    // Build final provider list
    const providers = Object.values(providerMap)
      .map((p) => ({
        id: p.id,
        name: p.name,
        totalRequests: p.totalRequests,
        successCount: p.successCount,
        errorCount: p.errorCount,
        successRate: p.totalRequests > 0 ? (p.successCount / p.totalRequests) * 100 : 0,
        avgLatency: p.latencyTotalCount > 0 ? Math.round(p.latencyTotalSum / p.latencyTotalCount) : 0,
        avgTtft: p.ttftCount > 0 ? Math.round(p.ttftSum / p.ttftCount) : 0,
        lastUsed: p.lastUsed,
        models: Object.values(p.models).map((m) => ({
          id: m.id,
          totalRequests: m.totalRequests,
          successCount: m.successCount,
          errorCount: m.errorCount,
          successRate: m.totalRequests > 0 ? (m.successCount / m.totalRequests) * 100 : 0,
          avgLatency: m.latencyTotalCount > 0 ? Math.round(m.latencyTotalSum / m.latencyTotalCount) : 0,
        })).sort((a, b) => b.totalRequests - a.totalRequests),
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
        recordCount: filtered.length,
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
