import {
  getAllCachedUsage,
  refreshAllConnectionsUsage,
  getQuotaCacheStatus,
} from "@/lib/usage/quotaCache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/usage/snapshot?ids=a,b,c
 *
 * Returns the cached raw usage objects for the requested connection ids (or all
 * cached entries when no ids are provided) together with scheduler status metadata.
 *
 * If the cache is cold (no entries at all), fires a background sweep so the
 * next poll will be warm.
 */
export async function GET(request) {
  try {
    const idsParam = request.nextUrl.searchParams.get("ids");
    const ids = idsParam
      ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const snapshot = getAllCachedUsage(ids);

    // Cold-cache guard: if nothing is in the cache at all, trigger a background
    // sweep so the next request arrives warm.
    const status = getQuotaCacheStatus();
    if (status.entryCount === 0 && !status.running) {
      refreshAllConnectionsUsage().catch((err) => {
        console.warn("[Snapshot] Background sweep trigger failed:", err.message);
      });
    }

    return Response.json({ snapshot, status });
  } catch (error) {
    console.warn("[Snapshot] GET error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/usage/snapshot
 *
 * Forces an immediate full sweep of all active connections and returns the
 * fresh snapshot. Used by the dashboard "Refresh all" button so a manual
 * refresh also benefits SmartRouting.
 */
export async function POST() {
  try {
    await refreshAllConnectionsUsage();
    const snapshot = getAllCachedUsage();
    const status = getQuotaCacheStatus();
    return Response.json({ snapshot, status });
  } catch (error) {
    console.warn("[Snapshot] POST error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
