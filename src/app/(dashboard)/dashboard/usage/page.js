"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";
import ProviderHealthTab from "./components/ProviderHealthTab";

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

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details", "health"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  // Params that are owned by a specific tab and should not leak to others
  const TAB_OWNED_PARAMS = { health: ["period"] };

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
    // Brief loading flash so user sees feedback
    setTimeout(() => setTabLoading(false), 300);
  };

  return (
    <div className="flex flex-col gap-6">
      <SegmentedControl
        options={[
          { value: "overview", label: "Overview" },
          { value: "details", label: "Details" },
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
              <UsageStats />
            </Suspense>
          )}
          {activeTab === "logs" && <RequestLogger />}
          {activeTab === "details" && <RequestDetailsTab />}
          {activeTab === "health" && <ProviderHealthTab />}
        </>
      )}
    </div>
  );
}

