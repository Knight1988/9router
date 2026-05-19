import { NextResponse } from "next/server";
import { aggregateBackfill } from "@/lib/db/index.js";

export async function POST() {
  try {
    const result = await aggregateBackfill();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] aggregate-health failed:", error);
    return NextResponse.json(
      { error: "Aggregation failed", detail: error.message },
      { status: 500 }
    );
  }
}
