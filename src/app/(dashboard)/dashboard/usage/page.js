"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";
import ProviderHealthTab from "./components/ProviderHealthTab";
import ApiKeyUsageTab from "./components/ApiKeyUsageTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details", "health", "apikeys"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  // Track which tabs have been activated at least once so we only mount them when first shown.
  // Once mounted, they stay in the DOM (hidden via CSS) so they don't re-fetch on tab switch.
  const [mountedTabs, setMountedTabs] = useState(() => new Set([activeTab]));

  // Params that are owned by a specific tab and should not leak to others
  const TAB_OWNED_PARAMS = { health: ["period"], apikeys: ["period"] };

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    setMountedTabs((prev) => {
      if (prev.has(value)) return prev;
      const next = new Set(prev);
      next.add(value);
      return next;
    });
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    // Remove tab-specific params when switching away from their owning tab
    for (const paramList of Object.values(TAB_OWNED_PARAMS)) {
      for (const param of paramList) params.delete(param);
    }
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-6">
      <SegmentedControl
        options={[
          { value: "overview", label: "Overview" },
          { value: "details", label: "Details" },
          { value: "apikeys", label: "API Key Usage" },
          { value: "health", label: "Provider Health" },
        ]}
        value={activeTab}
        onChange={handleTabChange}
      />

      {mountedTabs.has("overview") && (
        <div style={{ display: activeTab === "overview" ? "block" : "none" }}>
          <Suspense fallback={<CardSkeleton />}>
            <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
          </Suspense>
        </div>
      )}
      {mountedTabs.has("logs") && (
        <div style={{ display: activeTab === "logs" ? "block" : "none" }}>
          <RequestLogger />
        </div>
      )}
      {mountedTabs.has("details") && (
        <div style={{ display: activeTab === "details" ? "block" : "none" }}>
          <RequestDetailsTab />
        </div>
      )}
      {mountedTabs.has("apikeys") && (
        <div style={{ display: activeTab === "apikeys" ? "block" : "none" }}>
          <ApiKeyUsageTab />
        </div>
      )}
      {mountedTabs.has("health") && (
        <div style={{ display: activeTab === "health" ? "block" : "none" }}>
          <ProviderHealthTab />
        </div>
      )}
    </div>
  );
}
