"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Card from "@/shared/components/Card";
import { cn } from "@/shared/utils/cn";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "60d", "all"]);

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "60d", label: "60d" },
  { value: "all", label: "All" },
];

function getValidPeriod(raw) {
  return VALID_PERIODS.has(raw) ? raw : "7d";
}

function fmtLatency(ms) {
  if (!ms) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtTime(iso) {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function SuccessRateBar({ rate }) {
  const color =
    rate >= 95
      ? "bg-green-500"
      : rate >= 80
      ? "bg-yellow-500"
      : "bg-red-500";

  const textColor =
    rate >= 95
      ? "text-green-600 dark:text-green-400"
      : rate >= 80
      ? "text-yellow-600 dark:text-yellow-400"
      : "text-red-600 dark:text-red-400";

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 bg-black/10 dark:bg-white/10 rounded-full h-1.5 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${Math.min(rate, 100)}%` }}
        />
      </div>
      <span className={cn("text-xs font-mono font-semibold w-12 text-right", textColor)}>
        {rate.toFixed(1)}%
      </span>
    </div>
  );
}

function SortIcon({ field, currentSort, currentOrder }) {
  if (currentSort !== field) return <span className="ml-1 opacity-20">↕</span>;
  return <span className="ml-1">{currentOrder === "asc" ? "↑" : "↓"}</span>;
}

export default function ProviderHealthTab() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const period = getValidPeriod(searchParams.get("period"));

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [sortBy, setSortBy] = useState("totalRequests");
  const [sortOrder, setSortOrder] = useState("desc");

  const handlePeriodChange = useCallback((value) => {
    const params = new URLSearchParams(searchParams);
    params.set("period", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/provider-health?period=${period}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error("Failed to fetch provider health:", err);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("desc");
    }
  };

  const sortedProviders = data?.providers
    ? [...data.providers].sort((a, b) => {
        const aVal = a[sortBy] ?? 0;
        const bVal = b[sortBy] ?? 0;
        if (typeof aVal === "string") {
          return sortOrder === "asc"
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal);
        }
        return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
      })
    : [];

  const columns = [
    { field: "name", label: "Provider" },
    { field: "totalRequests", label: "Total", align: "right" },
    { field: "successCount", label: "Success", align: "right" },
    { field: "errorCount", label: "Errors", align: "right" },
    { field: "successRate", label: "Success Rate" },
    { field: "avgLatency", label: "Avg Latency", align: "right" },
    { field: "avgTtft", label: "Avg TTFT", align: "right" },
    { field: "lastUsed", label: "Last Used", align: "right" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Summary cards */}
      {data?.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card padding="md">
            <div className="text-xs text-text-muted mb-1">Total Requests</div>
            <div className="text-2xl font-bold">
              {data.summary.totalRequests.toLocaleString()}
            </div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-text-muted mb-1">Overall Success Rate</div>
            <div
              className={cn(
                "text-2xl font-bold",
                data.summary.overallSuccessRate >= 95
                  ? "text-green-600 dark:text-green-400"
                  : data.summary.overallSuccessRate >= 80
                  ? "text-yellow-600 dark:text-yellow-400"
                  : "text-red-600 dark:text-red-400"
              )}
            >
              {data.summary.overallSuccessRate.toFixed(1)}%
            </div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-text-muted mb-1">Providers</div>
            <div className="text-2xl font-bold">{data.summary.totalProviders}</div>
          </Card>
          <Card padding="md">
            <div className="text-xs text-text-muted mb-1">Data Window</div>
            <div className="text-2xl font-bold">{data.summary.recordCount.toLocaleString()}</div>
            <div className="text-xs text-text-muted mt-0.5">
              in period
              {data.summary.totalDbRecords != null && (
                <> · {data.summary.totalDbRecords.toLocaleString()} total stored</>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Period selector + table */}
      <Card padding="none">
        {/* Header with period filter */}
        <div className="p-4 border-b border-border flex items-center justify-between gap-4">
          <h3 className="font-semibold">Provider Health</h3>
          <div className="flex items-center gap-1">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => handlePeriodChange(p.value)}
                className={cn(
                  "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  period === p.value
                    ? "bg-primary text-white"
                    : "text-text-muted hover:bg-bg-subtle/60"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
              <tr>
                {/* Expand toggle */}
                <th className="px-4 py-3 w-8" />
                {columns.map((col) => (
                  <th
                    key={col.field}
                    className={cn(
                      "px-4 py-3 cursor-pointer hover:bg-bg-subtle/50 whitespace-nowrap",
                      col.align === "right" ? "text-right" : ""
                    )}
                    onClick={() => handleSort(col.field)}
                  >
                    {col.label}
                    <SortIcon
                      field={col.field}
                      currentSort={sortBy}
                      currentOrder={sortOrder}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">
                        progress_activity
                      </span>
                      Loading…
                    </div>
                  </td>
                </tr>
              ) : sortedProviders.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-text-muted">
                    No data found. Enable Observability in Settings to start tracking provider health.
                  </td>
                </tr>
              ) : (
                sortedProviders.map((provider) => (
                  <Fragment key={provider.id}>
                    {/* Provider row */}
                    <tr
                      className="hover:bg-bg-subtle/50 transition-colors cursor-pointer"
                      onClick={() => toggleExpanded(provider.id)}
                    >
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "material-symbols-outlined text-[18px] text-text-muted transition-transform",
                            expanded.has(provider.id) ? "rotate-90" : ""
                          )}
                        >
                          chevron_right
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium">{provider.name}</td>
                      <td className="px-4 py-3 text-right font-mono">{provider.totalRequests.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-mono text-green-600 dark:text-green-400">
                        {provider.successCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-red-600 dark:text-red-400">
                        {provider.errorCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <SuccessRateBar rate={provider.successRate} />
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-text-muted">
                        {fmtLatency(provider.avgLatency)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-text-muted">
                        {fmtLatency(provider.avgTtft)}
                      </td>
                      <td className="px-4 py-3 text-right text-text-muted text-xs">
                        {fmtTime(provider.lastUsed)}
                      </td>
                    </tr>

                    {/* Expanded model breakdown */}
                    {expanded.has(provider.id) &&
                      provider.models.map((model) => (
                        <tr
                          key={`${provider.id}-${model.id}`}
                          className="bg-bg-subtle/20"
                        >
                          <td className="px-4 py-2" />
                          <td className="px-4 py-2 pl-8 text-xs font-mono text-text-muted">
                            {model.id}
                          </td>
                          <td className="px-4 py-2 text-right text-xs font-mono text-text-muted">
                            {model.totalRequests.toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-right text-xs font-mono text-green-600/70 dark:text-green-400/70">
                            {model.successCount.toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-right text-xs font-mono text-red-600/70 dark:text-red-400/70">
                            {model.errorCount.toLocaleString()}
                          </td>
                          <td className="px-4 py-2">
                            <SuccessRateBar rate={model.successRate} />
                          </td>
                          <td className="px-4 py-2 text-right text-xs font-mono text-text-muted">
                            {fmtLatency(model.avgLatency)}
                          </td>
                          <td className="px-4 py-2" />
                          <td className="px-4 py-2" />
                        </tr>
                      ))}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
