import { NextResponse } from "next/server";
import { getTechopenclawModels, replaceTechopenclawModels } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const MODEL_LIMIT = 500;
function normalizeModel(entry) {
  const id = typeof entry === "string" ? entry.trim() : entry?.id;
  if (typeof id !== "string" || !id.trim() || id.includes("/") || id.length > 200) return null;
  const normalizedId = id.trim();
  if (typeof entry === "string") return { id: normalizedId, name: normalizedId };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (entry.name !== undefined && (typeof entry.name !== "string" || !entry.name.trim())) return null;
  const name = entry.name?.trim() || normalizedId;
  if (name.length > 200) return null;
  if (entry.kind !== undefined && entry.kind !== "llm") return null;
  return { id: normalizedId, name };
}

// GET /api/providers/techopenclaw/models - stored model list
export async function GET() {
  try {
    const models = await getTechopenclawModels();
    return NextResponse.json({ provider: "techopenclaw", models });
  } catch (error) {
    console.log("Error fetching techopenclaw models:", error);
    return NextResponse.json({ error: "Failed to fetch techopenclaw models" }, { status: 500 });
  }
}

// PUT /api/providers/techopenclaw/models - batch replace the stored list
// Body: { models: [{ id, name?, kind? }, ...] } or { models: ["model-id", ...] }
export async function PUT(request) {
  try {
    const body = await request.json();
    const raw = body?.models;
    if (!Array.isArray(raw)) {
      return NextResponse.json({ error: "models array required" }, { status: 400 });
    }
    if (raw.length > MODEL_LIMIT) {
      return NextResponse.json({ error: `Too many models (limit ${MODEL_LIMIT})` }, { status: 400 });
    }
    const seen = new Set();
    const models = [];
    for (const entry of raw) {
      const model = normalizeModel(entry);
      if (!model || seen.has(model.id)) {
        return NextResponse.json({ error: "Each model needs a unique valid id and optional name" }, { status: 400 });
      }
      seen.add(model.id);
      models.push(model);
    }
    await replaceTechopenclawModels(models);
    return NextResponse.json({ success: true, provider: "techopenclaw", count: models.length, models });
  } catch (error) {
    console.log("Error updating techopenclaw models:", error);
    return NextResponse.json({ error: "Failed to update techopenclaw models" }, { status: 500 });
  }
}
