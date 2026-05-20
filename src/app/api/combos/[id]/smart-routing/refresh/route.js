import { NextResponse } from "next/server";
import { getComboById } from "@/lib/localDb";
import { triggerSmartRoutingRefresh } from "@/lib/smartRouting/scheduler";

export const dynamic = "force-dynamic";

// POST /api/combos/[id]/smart-routing/refresh
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    await triggerSmartRoutingRefresh(combo.name);

    // Re-read fresh settings to get updated priority
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    const comboData = settings.comboStrategies?.[combo.name] || {};

    return NextResponse.json({
      ok: true,
      smartPriority: comboData.smartPriority || [],
      smartPriorityUpdatedAt: comboData.smartPriorityUpdatedAt || null,
      smartPriorityError: comboData.smartPriorityError || null,
    });
  } catch (error) {
    console.error("[SmartRouting] refresh error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
