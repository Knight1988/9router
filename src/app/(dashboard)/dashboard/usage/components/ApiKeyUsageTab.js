"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Card from "@/shared/components/Card";
import { cn } from "@/shared/utils/cn";

const VALID_PERIODS = new Set(["5h", "12h", "24h", "7d", "30d"]);

const PERIODS = [
  { value: "5h", label: "5h" },
  { value: "12h", label: "12h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const fmt = (n) => new Intl.NumberFormat().format(n || 0);

function getValidPeriod(raw) {
  return VALID_PERIODS.has(raw) ? raw : "7d";
}

function SortIcon({ field, currentSort, currentOrder }) {
  if (currentSort !== field) return <span className="ml-1 opacity-20">↕</span>;
  return <span className="ml-1">{currentOrder === "asc" ? "↑" : "↓"}</span>;
}

function collapseApiKeyUsage(byApiKey) {
  const rows = Object.values(byApiKey || {}).reduce((acc, item) => {
    const key = item.apiKeyKey || item.apiKey || "local-no-key";
    if (!acc[key]) {
      acc[key] = {
        apiKeyKey: key,
        keyName: item.keyName || "Unknown Key",
        totalRequests: 0,
        totalInput: 0,
        totalOutput: 0,
      };
    }

    acc[key].totalRequests += item.requests || 0;
    acc[key].totalInput += item.promptTokens || 0;
    acc[key].totalOutput += item.completionTokens || 0;

    return acc;
  }, {});

  return Object.values(rows);
}

export default function ApiKeyUsageTab() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const period = getValidPeriod(searchParams.get("period"));

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState("totalInput");
  const [sortOrder, setSortOrder] = useState("desc");

  const handlePeriodChange = useCallback((value) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      try {
        const res = await fetch(`/api/usage/stats?period=${period}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to fetch usage stats");
        if (!cancelled) setRows(collapseApiKeyUsage(json.byApiKey));
      } catch (err) {
        console.error("Failed to fetch API key usage:", err);
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, [period]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];

      if (typeof aVal === "string" && typeof bVal === "string") {
        const primary = sortOrder === "asc"
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
        if (primary !== 0) return primary;
      } else {
        const primary = sortOrder === "asc" ? aVal - bVal : bVal - aVal;
        if (primary !== 0) return primary;
      }

      if (sortBy !== "totalInput") {
        if (b.totalInput !== a.totalInput) return b.totalInput - a.totalInput;
      }
      if (sortBy !== "totalOutput") {
        if (b.totalOutput !== a.totalOutput) return b.totalOutput - a.totalOutput;
      }
      return b.totalRequests - a.totalRequests;
    });
  }, [rows, sortBy, sortOrder]);

  const handleSort = useCallback((field) => {
    if (sortBy === field) {
      setSortOrder((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortOrder(field === "keyName" ? "asc" : "desc");
  }, [sortBy]);

  const summary = useMemo(() => {
    return rows.reduce((acc, row) => {
      acc.totalRequests += row.totalRequests;
      acc.totalInput += row.totalInput;
      acc.totalOutput += row.totalOutput;
      return acc;
    }, { totalRequests: 0, totalInput: 0, totalOutput: 0 });
  }, [rows]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card padding="md">
          <div className="text-xs text-text-muted mb-1">API Keys</div>
          <div className="text-2xl font-bold">{fmt(rows.length)}</div>
        </Card>
        <Card padding="md">
          <div className="text-xs text-text-muted mb-1">Total Requests</div>
          <div className="text-2xl font-bold">{fmt(summary.totalRequests)}</div>
        </Card>
        <Card padding="md">
          <div className="text-xs text-text-muted mb-1">Total Input</div>
          <div className="text-2xl font-bold">{fmt(summary.totalInput)}</div>
        </Card>
        <Card padding="md">
          <div className="text-xs text-text-muted mb-1">Total Output</div>
          <div className="text-2xl font-bold">{fmt(summary.totalOutput)}</div>
        </Card>
      </div>

      <Card padding="none">
        <div className="p-4 border-b border-border flex items-center justify-between gap-4">
          <h3 className="font-semibold">Usage by API Key</h3>
          <div className="flex items-center gap-1 flex-wrap">
            {PERIODS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => handlePeriodChange(item.value)}
                className={cn(
                  "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  period === item.value
                    ? "bg-primary text-white"
                    : "text-text-muted hover:bg-bg-subtle/60"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
              <tr>
                <th
                  className="px-6 py-3 cursor-pointer hover:bg-bg-subtle/50"
                  onClick={() => handleSort("keyName")}
                >
                  API Key Name
                  <SortIcon field="keyName" currentSort={sortBy} currentOrder={sortOrder} />
                </th>
                <th
                  className="px-6 py-3 text-right cursor-pointer hover:bg-bg-subtle/50"
                  onClick={() => handleSort("totalRequests")}
                >
                  Total Requests
                  <SortIcon field="totalRequests" currentSort={sortBy} currentOrder={sortOrder} />
                </th>
                <th
                  className="px-6 py-3 text-right cursor-pointer hover:bg-bg-subtle/50"
                  onClick={() => handleSort("totalInput")}
                >
                  Total Input
                  <SortIcon field="totalInput" currentSort={sortBy} currentOrder={sortOrder} />
                </th>
                <th
                  className="px-6 py-3 text-right cursor-pointer hover:bg-bg-subtle/50"
                  onClick={() => handleSort("totalOutput")}
                >
                  Total Output
                  <SortIcon field="totalOutput" currentSort={sortBy} currentOrder={sortOrder} />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">
                        progress_activity
                      </span>
                      Loading…
                    </div>
                  </td>
                </tr>
              ) : sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-text-muted">
                    No API key usage recorded for this period.
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => (
                  <tr key={row.apiKeyKey} className="hover:bg-bg-subtle/20 transition-colors">
                    <td className="px-6 py-3 font-medium">{row.keyName}</td>
                    <td className="px-6 py-3 text-right">{fmt(row.totalRequests)}</td>
                    <td className="px-6 py-3 text-right text-primary">{fmt(row.totalInput)}</td>
                    <td className="px-6 py-3 text-right text-success">{fmt(row.totalOutput)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
