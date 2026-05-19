/**
 * Unit tests: Claudible, Open Claude, techopenclaw, and DevGo providers
 *             can add models to a combo.
 *
 * Covers:
 *  1. AI_PROVIDERS registration — each provider exists and appears in the
 *     correct bucket (APIKEY / FREE_TIER / etc.) so ModelSelectModal includes it.
 *  2. Hardcoded model lists — getModelsByProviderId() returns usable entries.
 *  3. passthroughModels + modelsFetcher shape — Claudible & techopenclaw.
 *  4. Claudible suggested-models — endpointId forwarded.
 *  5. POST /api/combos  — accepts models from all target providers (status 201).
 *  6. PUT  /api/combos/[id] — same (status 200).
 *  7. USAGE_SUPPORTED_PROVIDERS / USAGE_APIKEY_PROVIDERS regression guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── provider constants ─────────────────────────────────────────────────────
import {
  AI_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
  getProviderAlias,
} from "@/shared/constants/providers.js";

// ── model helpers ─────────────────────────────────────────────────────────
import { getModelsByProviderId } from "@/shared/constants/models.js";

// ── suggested-models fetcher ───────────────────────────────────────────────
import { fetchSuggestedModels } from "@/shared/utils/providerModelsFetcher.js";

// ── mock localDb before importing route handlers ───────────────────────────
vi.mock("@/lib/localDb.js", () => ({
  getCombos:      vi.fn(async () => []),
  createCombo:    vi.fn(async (data) => ({ id: "combo-test-1", ...data })),
  getComboByName: vi.fn(async () => null),
  getComboById:   vi.fn(async (id) => ({ id, name: "existing-combo", models: [], kind: null })),
  updateCombo:    vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteCombo:    vi.fn(async () => true),
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

const { POST }       = await import("@/app/api/combos/route.js");
const { PUT }        = await import("@/app/api/combos/[id]/route.js");
const { createCombo, updateCombo, getComboByName, getComboById } = await import("@/lib/localDb.js");

// ── helpers ────────────────────────────────────────────────────────────────

function makeRequest(body) {
  return new Request("http://localhost/api/combos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePutRequest(body) {
  return new Request("http://localhost/api/combos/combo-test-1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ALL_PROVIDER_BUCKETS = {
  ...OAUTH_PROVIDERS,
  ...FREE_PROVIDERS,
  ...FREE_TIER_PROVIDERS,
  ...APIKEY_PROVIDERS,
};

// Providers under test
const CLAUDIBLE_IDS = [
  "vip-claudible",
  "cc-claudible",
  "cn-claudible",
  "minimax-claudible",
  "claude-claudible",
];

const TARGET_PROVIDERS = [
  "techopenclaw",
  ...CLAUDIBLE_IDS,
  "open-claude",
  "devgo",
];

// ══════════════════════════════════════════════════════════════════════════
// 1. AI_PROVIDERS registration
// ══════════════════════════════════════════════════════════════════════════

describe("AI_PROVIDERS registration", () => {
  it.each(TARGET_PROVIDERS)("%s is defined in AI_PROVIDERS", (id) => {
    expect(AI_PROVIDERS[id]).toBeDefined();
    expect(AI_PROVIDERS[id].id).toBe(id);
  });

  it.each(TARGET_PROVIDERS)("%s appears in a provider bucket (included in ModelSelectModal PROVIDER_ORDER)", (id) => {
    expect(ALL_PROVIDER_BUCKETS[id]).toBeDefined();
  });

  it.each(TARGET_PROVIDERS)("%s alias matches provider id (alias = provider id for these gateways)", (id) => {
    expect(getProviderAlias(id)).toBe(id);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Hardcoded model lists
// ══════════════════════════════════════════════════════════════════════════

describe("hardcoded model lists", () => {
  const PROVIDERS_WITH_HARDCODED_MODELS = [
    "techopenclaw",
    ...CLAUDIBLE_IDS,
    "open-claude",
    "devgo",
  ];

  it.each(PROVIDERS_WITH_HARDCODED_MODELS)("%s has at least one hardcoded model", (id) => {
    const models = getModelsByProviderId(id);
    expect(models.length).toBeGreaterThan(0);
  });

  it.each(PROVIDERS_WITH_HARDCODED_MODELS)("%s model entries have id and name", (id) => {
    const models = getModelsByProviderId(id);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
    }
  });

  it.each(PROVIDERS_WITH_HARDCODED_MODELS)("%s combo value is alias/modelId format", (id) => {
    const alias  = getProviderAlias(id);
    const models = getModelsByProviderId(id);
    const first  = models[0];
    const value  = `${alias}/${first.id}`;
    expect(value).toMatch(/^[^/]+\/[^/]+/);
  });

});

// ══════════════════════════════════════════════════════════════════════════
// 3. passthroughModels + modelsFetcher shape
// ══════════════════════════════════════════════════════════════════════════

describe("passthroughModels and modelsFetcher shape", () => {
  it.each(CLAUDIBLE_IDS)("%s has passthroughModels=true", (id) => {
    expect(AI_PROVIDERS[id].passthroughModels).toBe(true);
  });

  it("techopenclaw has passthroughModels=true", () => {
    expect(AI_PROVIDERS.techopenclaw.passthroughModels).toBe(true);
  });

  it.each(CLAUDIBLE_IDS)("%s modelsFetcher type is claudible-endpoint", (id) => {
    const f = AI_PROVIDERS[id].modelsFetcher;
    expect(f).toBeDefined();
    expect(f.type).toBe("claudible-endpoint");
  });

  it.each(CLAUDIBLE_IDS)("%s modelsFetcher has a valid https url", (id) => {
    const { url } = AI_PROVIDERS[id].modelsFetcher;
    expect(url).toMatch(/^https:\/\//);
  });

  it.each(CLAUDIBLE_IDS)("%s modelsFetcher has a non-empty endpointId", (id) => {
    const { endpointId } = AI_PROVIDERS[id].modelsFetcher;
    expect(typeof endpointId).toBe("string");
    expect(endpointId.length).toBeGreaterThan(0);
  });

  it("techopenclaw modelsFetcher type is openai-all", () => {
    const f = AI_PROVIDERS.techopenclaw.modelsFetcher;
    expect(f).toBeDefined();
    expect(f.type).toBe("openai-all");
    expect(f.url).toMatch(/^https:\/\//);
  });

  it.each(CLAUDIBLE_IDS)("%s fetcher endpointIds are distinct", () => {
    const ids = CLAUDIBLE_IDS.map((id) => AI_PROVIDERS[id].modelsFetcher.endpointId);
    const unique = new Set(ids);
    expect(unique.size).toBe(CLAUDIBLE_IDS.length);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. Claudible suggested-models — endpointId forwarded
// ══════════════════════════════════════════════════════════════════════════

describe("claudible fetchSuggestedModels passes endpointId (mocked)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch  = vi.fn(async () => {
      return new Response(
        JSON.stringify({ data: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each(CLAUDIBLE_IDS)("%s fetcher call includes endpointId param", async (id) => {
    const fetcher = AI_PROVIDERS[id].modelsFetcher;
    await fetchSuggestedModels(fetcher);

    const calledUrl = String(global.fetch.mock.calls[0][0]);
    expect(calledUrl).toContain(`endpointId=${fetcher.endpointId}`);
  });

  it.each(CLAUDIBLE_IDS)("%s suggested-models returns models", async (id) => {
    const fetcher = AI_PROVIDERS[id].modelsFetcher;
    const result  = await fetchSuggestedModels(fetcher);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. POST /api/combos — accepts models from all target providers
// ══════════════════════════════════════════════════════════════════════════

describe("POST /api/combos — accepts provider model values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default: name doesn't exist yet
    getComboByName.mockResolvedValue(null);
    createCombo.mockImplementation(async (data) => ({ id: "combo-test-1", ...data }));
  });

  it("creates combo with models from techopenclaw", async () => {
    const models = getModelsByProviderId("techopenclaw")
      .slice(0, 2)
      .map((m) => `techopenclaw/${m.id}`);

    const req = makeRequest({ name: "toc-combo", models, kind: null });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(createCombo).toHaveBeenCalledOnce();
    expect(createCombo.mock.calls[0][0].models).toEqual(models);
    expect(body.models).toEqual(models);
  });

  it.each(CLAUDIBLE_IDS)("creates combo with models from %s", async (id) => {
    const models = getModelsByProviderId(id)
      .slice(0, 2)
      .map((m) => `${id}/${m.id}`);

    const req = makeRequest({ name: `${id}-combo`, models, kind: null });
    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(createCombo.mock.calls[0][0].models).toEqual(models);
  });

  it("creates combo with models from open-claude", async () => {
    const models = getModelsByProviderId("open-claude")
      .slice(0, 2)
      .map((m) => `open-claude/${m.id}`);

    const req = makeRequest({ name: "oc-combo", models, kind: null });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.models).toEqual(models);
  });

  it("creates combo with devgo model value", async () => {
    const models = getModelsByProviderId("devgo").slice(0, 2).map((m) => `devgo/${m.id}`);

    const req = makeRequest({ name: "devgo-combo", models, kind: null });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.models).toEqual(models);
  });

  it("creates a mixed combo with models from all four provider families", async () => {
    const models = [
      `techopenclaw/${getModelsByProviderId("techopenclaw")[0].id}`,
      `vip-claudible/${getModelsByProviderId("vip-claudible")[0].id}`,
      `open-claude/${getModelsByProviderId("open-claude")[0].id}`,
      `devgo/${getModelsByProviderId("devgo")[0].id}`,
    ];

    const req = makeRequest({ name: "mixed-combo", models, kind: null });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.models).toHaveLength(4);
    expect(body.models).toEqual(models);
  });

  it("rejects a combo with a missing name", async () => {
    const req = makeRequest({ models: ["techopenclaw/claude-opus-4.7"] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(createCombo).not.toHaveBeenCalled();
  });

  it("rejects a combo when name already exists", async () => {
    getComboByName.mockResolvedValue({ id: "existing-id", name: "dup" });
    const req = makeRequest({ name: "dup", models: ["techopenclaw/claude-opus-4.7"] });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(createCombo).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. PUT /api/combos/[id] — accepts provider model values
// ══════════════════════════════════════════════════════════════════════════

describe("PUT /api/combos/[id] — accepts provider model values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getComboByName.mockResolvedValue(null);
    getComboById.mockResolvedValue({ id: "combo-test-1", name: "existing-combo", models: [], kind: null });
    updateCombo.mockImplementation(async (id, patch) => ({ id, ...patch }));
  });

  it("updates models with techopenclaw entries", async () => {
    const models = getModelsByProviderId("techopenclaw")
      .slice(0, 3)
      .map((m) => `techopenclaw/${m.id}`);

    const req = makePutRequest({ models });
    const res = await PUT(req, { params: Promise.resolve({ id: "combo-test-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(updateCombo).toHaveBeenCalledOnce();
    expect(body.models).toEqual(models);
  });

  it.each(CLAUDIBLE_IDS)("updates models with %s entries", async (id) => {
    const models = getModelsByProviderId(id).map((m) => `${id}/${m.id}`);

    const req = makePutRequest({ models });
    const res = await PUT(req, { params: Promise.resolve({ id: "combo-test-1" }) });

    expect(res.status).toBe(200);
    expect(updateCombo.mock.calls[0][1].models).toEqual(models);
  });

  it("updates models with open-claude entries", async () => {
    const models = getModelsByProviderId("open-claude").map((m) => `open-claude/${m.id}`);

    const req = makePutRequest({ models });
    const res = await PUT(req, { params: Promise.resolve({ id: "combo-test-1" }) });

    expect(res.status).toBe(200);
    expect(updateCombo.mock.calls[0][1].models).toEqual(models);
  });

  it("updates models with devgo entries", async () => {
    const models = getModelsByProviderId("devgo").slice(0, 2).map((m) => `devgo/${m.id}`);

    const req = makePutRequest({ models });
    const res = await PUT(req, { params: Promise.resolve({ id: "combo-test-1" }) });

    expect(res.status).toBe(200);
    expect(updateCombo.mock.calls[0][1].models).toEqual(models);
  });

  it("updates a combo with models from all four provider families simultaneously", async () => {
    const models = [
      `techopenclaw/${getModelsByProviderId("techopenclaw")[0].id}`,
      `cc-claudible/${getModelsByProviderId("cc-claudible")[0].id}`,
      `open-claude/${getModelsByProviderId("open-claude")[0].id}`,
      `devgo/${getModelsByProviderId("devgo")[0].id}`,
    ];

    const req = makePutRequest({ models });
    const res = await PUT(req, { params: Promise.resolve({ id: "combo-test-1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.models).toEqual(models);
  });

  it("returns 404 when combo does not exist", async () => {
    getComboById.mockResolvedValue(null);
    updateCombo.mockResolvedValue(null);

    const req = makePutRequest({ models: ["techopenclaw/claude-opus-4.7"] });
    const res = await PUT(req, { params: Promise.resolve({ id: "nonexistent" }) });

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 8. USAGE_SUPPORTED_PROVIDERS / USAGE_APIKEY_PROVIDERS regression guard
// ══════════════════════════════════════════════════════════════════════════

describe("USAGE_SUPPORTED_PROVIDERS and USAGE_APIKEY_PROVIDERS regression guard", () => {
  it.each(TARGET_PROVIDERS)("%s is in USAGE_SUPPORTED_PROVIDERS", (id) => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain(id);
  });

  const APIKEY_GATEWAY_PROVIDERS = [
    "vip-claudible",
    "cc-claudible",
    "cn-claudible",
    "minimax-claudible",
    "claude-claudible",
    "techopenclaw",
    "devgo",
    "open-claude",
  ];

  it.each(APIKEY_GATEWAY_PROVIDERS)("%s is in USAGE_APIKEY_PROVIDERS", (id) => {
    expect(USAGE_APIKEY_PROVIDERS).toContain(id);
  });
});
