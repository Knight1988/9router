import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName, getSettings, updateSettings } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";
import { validateComboForSmartRouting } from "@/lib/smartRouting/quotaCheck";

/**
 * Clear cached smartPriority for a combo name from settings.comboStrategies.
 * Called after edit or delete so stale priority doesn't persist.
 */
async function clearSmartPriorityCache(comboName) {
  if (!comboName) return;
  try {
    const settings = await getSettings();
    const strategies = settings.comboStrategies || {};
    if (!strategies[comboName]) return;
    const updated = {
      ...strategies,
      [comboName]: {
        ...strategies[comboName],
        smartPriority: [],
        smartPriorityUpdatedAt: null,
        smartPriorityError: null,
      },
    };
    await updateSettings({ comboStrategies: updated });
  } catch (err) {
    console.warn("[Combos] Failed to clear smartPriority cache:", err.message);
  }
}

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    
    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }
    
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);
    const combo = await updateCombo(id, body);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    // Clear cached smartPriority when models or name changes
    if (body.models !== undefined || body.name !== undefined) {
      await clearSmartPriorityCache(prev?.name);
      if (combo.name && combo.name !== prev?.name) {
        await clearSmartPriorityCache(combo.name);
      }
      // If smart routing is on, re-validate and either refresh or auto-disable
      try {
        const settings = await getSettings();
        const strategy = settings.comboStrategies?.[combo.name]?.fallbackStrategy;
        if (strategy === "smart-routing") {
          const validation = await validateComboForSmartRouting(combo);
          if (!validation.ok) {
            // Models no longer support quota checks — auto-disable smart routing
            const strategies = settings.comboStrategies || {};
            const { fallbackStrategy, smartPriority, smartPriorityUpdatedAt, smartPriorityError, ...rest } = strategies[combo.name] || {};
            const updated = { ...strategies };
            if (Object.keys(rest).length === 0) {
              delete updated[combo.name];
            } else {
              updated[combo.name] = rest;
            }
            await updateSettings({ comboStrategies: updated });
            console.warn(`[Combos] Auto-disabled smart routing for "${combo.name}": unsupported providers ${validation.unsupported.join(", ")}`);
          } else {
            const { triggerSmartRoutingRefresh } = await import("@/lib/smartRouting/scheduler.js");
            triggerSmartRoutingRefresh(combo.name).catch(() => {});
          }
        }
      } catch {
        // non-fatal
      }
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) {
      resetComboRotation(prev.name);
      await clearSmartPriorityCache(prev.name);
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
