import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let route;
let catalog;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-techopenclaw-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  route = await import("@/app/api/providers/techopenclaw/models/route.js");
  catalog = await import("open-sse/providers/index.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function put(models) {
  return route.PUT(new Request("http://localhost/api/providers/techopenclaw/models", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models }),
  }));
}

describe("techopenclaw DB catalog", () => {
  it("seeds the shipped catalog only once, then replaces and reads a batch", async () => {
    const seeded = await db.getTechopenclawModels();
    expect(seeded).toEqual(catalog.PROVIDER_MODELS.techopenclaw);
    expect(seeded.some((m) => m.id === "claude-opus-5-ccmax")).toBe(true);

    const res = await put([{ id: "model-a", name: "Model A" }, "model-b"]);
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(2);
    expect(await db.getTechopenclawModels()).toEqual([
      { id: "model-a", name: "Model A" }, { id: "model-b", name: "model-b" },
    ]);
    expect((await route.GET()).status).toBe(200);
    expect((await (await route.GET()).json()).models).toEqual(catalog.PROVIDER_MODELS.techopenclaw);
    expect(seeded.length).toBeGreaterThan(2);
  });

  it("rejects invalid and duplicate models without modifying the catalog", async () => {
    const before = await db.getTechopenclawModels();
    expect((await put(["valid", "valid"])).status).toBe(400);
    expect((await put([{ id: "invalid/provider" }])).status).toBe(400);
    expect((await put("not-an-array")).status).toBe(400);
    expect(await db.getTechopenclawModels()).toEqual(before);
  });

  it("preserves intentional empty lists through reload and export/import", async () => {
    expect((await put([])).status).toBe(200);
    expect(await db.loadTechopenclawModels()).toEqual([]);
    const exported = await db.exportDb();
    expect(exported.techopenclawModels).toEqual([]);
    await db.importDb(exported);
    expect(await db.getTechopenclawModels()).toEqual([]);
    expect(catalog.PROVIDER_MODELS.techopenclaw).toEqual([]);
  });
});
