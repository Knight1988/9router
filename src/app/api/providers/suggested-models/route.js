import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  if (type === "claudible-endpoint") {
    const endpointId = searchParams.get("endpointId");
    if (!endpointId) {
      return NextResponse.json({ error: "Missing endpointId" }, { status: 400 });
    }
    try {
      const res = await fetch(url);
      if (!res.ok) return NextResponse.json({ data: [] });
      const json = await res.json();
      const endpoint = (json.endpoints || []).find((e) => e.id === endpointId);
      if (!endpoint) return NextResponse.json({ data: [] });
      const data = (endpoint.models || []).map((m) => ({
        id: m.modelName,
        name: m.modelName,
        description: m.description || undefined,
      }));
      return NextResponse.json({ data });
    } catch {
      return NextResponse.json({ data: [] });
    }
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
