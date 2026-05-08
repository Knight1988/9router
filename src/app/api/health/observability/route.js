import { NextResponse } from "next/server";
import { getDb } from "@/lib/requestDetailsDb";
import { getSettings } from "@/lib/localDb";

export async function GET() {
  try {
    const settings = await getSettings();
    const enabled = settings.observabilityEnabled ?? settings.enableObservability ?? true;
    
    if (!enabled) {
      return NextResponse.json({
        enabled: false,
        databaseInitialized: false,
        recordCount: 0,
        message: "Observability is disabled in settings"
      });
    }

    let databaseInitialized = false;
    let recordCount = 0;
    let oldestRecord = null;
    let newestRecord = null;
    let providers = [];

    try {
      const db = getDb();
      databaseInitialized = true;

      const countResult = db.prepare("SELECT COUNT(*) as count FROM request_details").get();
      recordCount = countResult.count;

      if (recordCount > 0) {
        const dateRange = db.prepare(
          "SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM request_details"
        ).get();
        oldestRecord = dateRange.oldest;
        newestRecord = dateRange.newest;

        const providerList = db.prepare(
          "SELECT DISTINCT provider FROM request_details WHERE provider IS NOT NULL ORDER BY provider"
        ).all();
        providers = providerList.map(p => p.provider);
      }
    } catch (err) {
      console.error("[health/observability] Database error:", err);
      return NextResponse.json({
        enabled,
        databaseInitialized: false,
        error: "Database initialization failed",
        details: err.message
      }, { status: 500 });
    }

    return NextResponse.json({
      enabled,
      databaseInitialized,
      recordCount,
      oldestRecord,
      newestRecord,
      providers,
      status: recordCount > 0 ? "healthy" : "no_data"
    });
  } catch (err) {
    console.error("[health/observability] Error:", err);
    return NextResponse.json({
      error: "Internal server error",
      details: err.message
    }, { status: 500 });
  }
}
