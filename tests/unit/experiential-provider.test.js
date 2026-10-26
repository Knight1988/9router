import { describe, it, expect, vi, afterEach } from "vitest";
import { AI_PROVIDERS, APIKEY_PROVIDERS, getProviderAlias } from "@/shared/constants/providers.js";
import { getModelsByProviderId } from "@/shared/constants/models.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { DefaultExecutor } from "open-sse/executors/default.js";

vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(async () => ({
    id: "experiential-account", provider: "experiential", apiKey: "test-key",
  })),
  getProviderNodeById: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(async () => ({
    id: "experiential-account", provider: "experiential", authType: "apikey", apiKey: "test-key",
  })),
  updateProviderConnection: vi.fn(),
  getTechopenclawModels: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
import { GET } from "@/app/api/providers/[id]/models/route.js";
import { POST } from "@/app/api/providers/validate/route.js";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";

afterEach(() => vi.unstubAllGlobals());

describe("Experiential Labs", () => {
  it.each([200, 401, 403, 500])("validates and retests credentials through the model endpoint (%s)", async (status) => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST", body: JSON.stringify({ provider: "experiential", apiKey: "test-key" }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).valid).toBe(status === 200);
    const result = await testSingleConnection("experiential-account");
    expect(result.valid).toBe(status === 200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.experientiallabs.ai/v1/models");
      expect(options.headers).toMatchObject({ Authorization: "Bearer test-key" });
    }
  });
  it("discovers account models with Bearer authentication", async () => {
    const models = [{ id: "qwen3.8-27b" }, { id: "org-custom-model" }];
    const fetchMock = vi.fn(async () => Response.json({ data: models }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("http://localhost/api/providers/experiential-account/models"), {
      params: Promise.resolve({ id: "experiential-account" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual(models);
    expect(fetchMock).toHaveBeenCalledWith("https://api.experientiallabs.ai/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
    }));
  });
  it("registers an OpenAI-compatible API-key provider with the advertised model", () => {
    expect(APIKEY_PROVIDERS.experiential).toBeDefined();
    expect(AI_PROVIDERS.experiential.name).toBe("Experiential Labs");
    expect(getProviderAlias("experiential")).toBe("experiential");
    expect(PROVIDERS.experiential).toMatchObject({
      format: "openai",
      baseUrl: "https://api.experientiallabs.ai/v1/chat/completions",
      validateUrl: "https://api.experientiallabs.ai/v1/models",
    });
    expect(getModelsByProviderId("experiential")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qwen3.8-27b", name: "Qwen3.8 27B" }),
    ]));
    const executor = new DefaultExecutor("experiential");
    expect(executor.buildUrl("qwen3.8-27b", true)).toBe("https://api.experientiallabs.ai/v1/chat/completions");
    expect(executor.buildHeaders({ apiKey: "test-key" })).toMatchObject({
      Authorization: "Bearer test-key", "Content-Type": "application/json",
    });
  });
});
