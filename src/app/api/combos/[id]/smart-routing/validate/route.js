import { NextResponse } from "next/server";
import { getComboById } from "@/lib/localDb";
import { validateComboForSmartRouting } from "@/lib/smartRouting/quotaCheck";

export const dynamic = "force-dynamic";

// POST /api/combos/[id]/smart-routing/validate
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const result = await validateComboForSmartRouting(combo);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[SmartRouting] validate error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
