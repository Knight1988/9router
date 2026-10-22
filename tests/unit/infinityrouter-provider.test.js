import { describe, it, expect, vi, afterEach } from "vitest";
import { AI_PROVIDERS, APIKEY_PROVIDERS, getProviderAlias } from "@/shared/constants/providers.js";
import { getModelsByProviderId } from "@/shared/constants/models.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { DefaultExecutor } from "open-sse/executors/default.js";

vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(async () => ({
    id: "infinity-account", provider: "infinityrouter", apiKey: "test-key",
  })),
  getProviderNodeById: vi.fn(),
}));

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { POST } from "@/app/api/providers/validate/route.js";
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(async () => ({
    id: "infinity-account", provider: "infinityrouter", authType: "apikey", apiKey: "test-key",
  })),
  updateProviderConnection: vi.fn(),
  getTechopenclawModels: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";

afterEach(() => vi.unstubAllGlobals());

function stubModels(status = 200) {
  const fetchMock = vi.fn(async () => Response.json({
    data: [{ id: "discovered-model", display_name: "Discovered Model" }],
  }, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("InfinityRouter", () => {
  it.each([200, 401, 403, 500])("validates and retests credentials using the model endpoint (%s)", async (status) => {
    const fetchMock = stubModels(status);
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST", body: JSON.stringify({ provider: "infinityrouter", apiKey: "test-key" }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).valid).toBe(status === 200);
    const result = await testSingleConnection("infinity-account");
    expect(result.valid).toBe(status === 200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("https://infinityrouter.dev/v1/models");
      expect(options.headers).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
    }
  });
  it("discovers account models with Anthropic authentication", async () => {
    const fetchMock = stubModels();
    const response = await GET(new Request("http://localhost/api/providers/infinity-account/models"), {
      params: Promise.resolve({ id: "infinity-account" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual([
      { id: "discovered-model", display_name: "Discovered Model" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://infinityrouter.dev/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" }),
    }));
  });
  it("registers an API-key Claude gateway with usable combo models", () => {
    expect(APIKEY_PROVIDERS.infinityrouter).toBeDefined();
    expect(AI_PROVIDERS.infinityrouter.name).toBe("InfinityRouter");
    expect(getProviderAlias("infinityrouter")).toBe("infinityrouter");
    expect(PROVIDERS.infinityrouter).toMatchObject({
      format: "claude", baseUrl: "https://infinityrouter.dev/v1/messages",
    });
    expect(getModelsByProviderId("infinityrouter").map(m => m.id)).toEqual(expect.arrayContaining([
      "claude-opus-5-5", "claude-sonnet-5-5", "minimax-m3",
    ]));
    const executor = new DefaultExecutor("infinityrouter");
    expect(executor.buildUrl("claude-opus-5-5", true)).toBe("https://infinityrouter.dev/v1/messages");
    expect(executor.buildHeaders({ apiKey: "test-key" })).toMatchObject({
      "x-api-key": "test-key", "anthropic-version": "2023-06-01",
    });
  });
});
