"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";
import ProviderHealthTab from "./components/ProviderHealthTab";
import ApiKeyUsageTab from "./components/ApiKeyUsageTab";

const PERIODS = [
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

  const [tabLoading, setTabLoading] = useState(false);
  const [period, setPeriod] = useState("7d");

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details", "health", "apikeys"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  // Params that are owned by a specific tab and should not leak to others
  const TAB_OWNED_PARAMS = { health: ["period"], apikeys: ["period"] };

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    setTabLoading(true);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    // Remove tab-specific params when switching away from their owning tab
    for (const paramList of Object.values(TAB_OWNED_PARAMS)) {
      for (const param of paramList) params.delete(param);
    }
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
    setTimeout(() => setTabLoading(false), 300);
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

      {tabLoading ? (
        <CardSkeleton />
      ) : (
        <>
          {activeTab === "overview" && (
            <Suspense fallback={<CardSkeleton />}>
              <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
            </Suspense>
          )}
          {activeTab === "logs" && <RequestLogger />}
          {activeTab === "details" && <RequestDetailsTab />}
          {activeTab === "apikeys" && <ApiKeyUsageTab />}
          {activeTab === "health" && <ProviderHealthTab />}
        </>
      )}
    </div>
  );
}
