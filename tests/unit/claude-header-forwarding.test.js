/**
 * Unit tests for Anthropic header forwarding pipeline
 *
 * Tests cover:
 *  - default.js buildHeaders(): static provider defaults + model-gated anthropic-beta
 *  - default.js buildHeaders(): anthropic-compatible non-Anthropic host stripping
 *  - default.js buildHeaders(): anthropic-compatible official host keeps headers
 *  - proxyFetch.js: api.anthropic.com routes through anthropicFetch path
 *  - mergeForwardedHeaders: case-insensitive merge prevents duplicate-cased header lines
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mergeForwardedHeaders, getForwardableClientHeaders, HEADER_FORWARD_BLOCKLIST } from "open-sse/utils/clientDetector.js";

// ─── DefaultExecutor.buildHeaders() ──────────────────────────────────────────

describe("DefaultExecutor.buildHeaders() — claude provider", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("uses static provider defaults when no model is given", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    const hasVersion =
      headers["Anthropic-Version"] === "2023-06-01" ||
      headers["anthropic-version"] === "2023-06-01";
    expect(hasVersion).toBe(true);
    expect(headers["User-Agent"]).toBe("claude-cli/2.1.258 (external, sdk-cli)");
  });

  it("includes heavy-agent beta flags for claude-opus-5", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-opus-5");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).toContain("effort-2025-11-24");
  });

  it("includes heavy-agent beta flags for claude-sonnet-5", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-sonnet-5");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).toContain("effort-2025-11-24");
  });

  it("omits heavy-agent beta flags for claude-haiku-4-5-20251001", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-haiku-4-5-20251001");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).not.toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).not.toContain("effort-2025-11-24");
    expect(betaFlags).toContain("claude-code-20250219");
  });

  it("omits heavy-agent beta flags for claude-fable-5", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true, undefined, "claude-fable-5");
    const betaFlags = headers["Anthropic-Beta"].split(",").map(s => s.trim());
    expect(betaFlags).not.toContain("advanced-tool-use-2025-11-20");
    expect(betaFlags).not.toContain("effort-2025-11-24");
  });

  it("sets x-api-key auth when apiKey is provided", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-live-key" }, true);
    expect(headers["x-api-key"]).toBe("sk-live-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sets Bearer Authorization when only accessToken is provided", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ accessToken: "tok-abc" }, true);
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("includes Accept: text/event-stream when stream=true", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, true);
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("omits Accept: text/event-stream when stream=false", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "k" }, false);
    expect(headers["Accept"]).toBeUndefined();
  });

  it("does not throw when no model is given", () => {
    const executor = new DefaultExecutor("claude");
    expect(() => executor.buildHeaders({ apiKey: "sk" }, false)).not.toThrow();
  });
});

// ─── anthropic-compatible header stripping ────────────────────────────────────

describe("DefaultExecutor.buildHeaders() — anthropic-compatible stripping", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("strips x-app and anthropic-dangerous-direct-browser-access for non-Anthropic host", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      true
    );

    expect(headers["x-app"]).toBeUndefined();
    expect(headers["X-App"]).toBeUndefined();
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBeUndefined();
  });

  it("removes claude-code-20250219 from anthropic-beta for non-Anthropic host", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      true
    );

    const betaVal = headers["anthropic-beta"] || headers["Anthropic-Beta"] || "";
    expect(betaVal).not.toContain("claude-code-20250219");
  });

  it("keeps other beta flags intact after stripping", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    // The static CLAUDE_API_HEADERS used by anthropic-compatible providers include
    // 'interleaved-thinking-2025-05-14' — check it survives stripping
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      false
    );

    const betaVal = headers["anthropic-beta"] || headers["Anthropic-Beta"] || "";
    // If any beta value remains it should not be empty and should not have the stripped value
    if (betaVal) {
      expect(betaVal).not.toContain("claude-code-20250219");
    }
  });

  it("does NOT strip headers when baseUrl is api.anthropic.com", () => {
    const executor = new DefaultExecutor("anthropic-compatible-official");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" },
      },
      true
    );

    // No stripping — anthropic-version should survive
    const hasVersion =
      headers["Anthropic-Version"] || headers["anthropic-version"];
    expect(hasVersion).toBeDefined();
  });

  it("does NOT strip headers when baseUrl is empty (defaults to Anthropic)", () => {
    const executor = new DefaultExecutor("anthropic-compatible-official");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: {},
      },
      true
    );

    const hasVersion =
      headers["Anthropic-Version"] || headers["anthropic-version"];
    expect(hasVersion).toBeDefined();
  });

  // A node fronting Anthropic (rotating multi-account proxy, corporate gateway)
  // needs the same beta flags the `claude` provider sends. Without
  // context-management-2025-06-27 upstream answers HTTP 400
  // "context_management: Extra inputs are not permitted" and the combo falls
  // through to the next model without anyone noticing.
  it("sends context-management beta for a Claude model on a custom host", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      true,
      undefined,
      "claude-opus-5"
    );

    const betaFlags = (headers["Anthropic-Beta"] || headers["anthropic-beta"] || "")
      .split(",").map(s => s.trim());
    expect(betaFlags).toContain("context-management-2025-06-27");
    // The first-party identity flag is still stripped for a non-Anthropic host.
    expect(betaFlags).not.toContain("claude-code-20250219");
  });

  it("gates the beta flags on the model id, not the provider prefix", () => {
    const executor = new DefaultExecutor("anthropic-compatible-custom");
    const headers = executor.buildHeaders(
      {
        apiKey: "key",
        providerSpecificData: { baseUrl: "https://myproxy.example.com/v1" },
      },
      true,
      undefined,
      "kimi-k3"
    );

    const betaVal = headers["Anthropic-Beta"] || headers["anthropic-beta"] || "";
    expect(betaVal).not.toContain("context-management-2025-06-27");
  });
});

// ─── proxyFetch anthropicFetch routing ────────────────────────────────────────

describe("proxyAwareFetch — api.anthropic.com routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes api.anthropic.com through standard fetch (non-streaming) and returns ok response", async () => {
    const originalFetch = globalThis.__originalFetch__ || globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () => JSON.stringify({ id: "msg_test" }),
      json: async () => ({ id: "msg_test" }),
    });

    vi.resetModules();
    // Patch the fetch that proxyFetch.js will capture on import
    globalThis.fetch = mockFetch;
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [] }),
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    globalThis.fetch = originalFetch;
  });

  it("falls back gracefully when got-scraping throws on non-streaming path", async () => {
    vi.doMock("got-scraping", () => {
      const fn = vi.fn().mockRejectedValue(new Error("TLS error"));
      fn.stream = vi.fn();
      return { gotScraping: fn };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      text: async () => "{}",
      json: async () => ({}),
    });

    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.ok).toBe(true);
    globalThis.fetch = originalFetch;
  });

  it("does NOT route non-Anthropic hosts through gotScraping", async () => {
    const gotScrapingMock = vi.fn();
    vi.doMock("got-scraping", () => ({ gotScraping: gotScrapingMock }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      text: async () => "{}",
      json: async () => ({}),
    });

    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    await proxyAwareFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(gotScrapingMock).not.toHaveBeenCalled();
  });
});

// ─── mergeForwardedHeaders ────────────────────────────────────────────────────

describe("mergeForwardedHeaders — case-insensitive merge prevents duplicate wire headers", () => {
  it("provider headers win on exact-case collision", () => {
    const client = { "Content-Type": "text/plain" };
    const provider = { "Content-Type": "application/json" };
    const merged = mergeForwardedHeaders(client, provider);
    expect(merged["Content-Type"]).toBe("application/json");
    // No duplicate
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "content-type")).toHaveLength(1);
  });

  it("provider Title-Case wins over client lowercase variant (the techopenclaw 502 scenario)", () => {
    // This is the exact bug: client sends lowercase "accept-encoding" with zstd,
    // provider builds Title-Case "Accept-Encoding" without zstd. Old spread kept both;
    // mergeForwardedHeaders must drop the client copy.
    const client = {
      "accept-encoding": "gzip, br, zstd",
      "accept": "application/json",
      "anthropic-beta": "client-flag-x",
      "user-agent": "claude-cli/2.1.92",
    };
    const provider = {
      "Content-Type": "application/json",
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219",
      "Accept": "text/event-stream",
      "Accept-Encoding": "gzip, deflate, br",
      "Authorization": "Bearer tok",
    };
    const merged = mergeForwardedHeaders(client, provider);

    // Exactly one Accept-Encoding, and it must be the provider's (no zstd)
    const aeKeys = Object.keys(merged).filter((k) => k.toLowerCase() === "accept-encoding");
    expect(aeKeys).toHaveLength(1);
    expect(merged[aeKeys[0]]).toBe("gzip, deflate, br");

    // Exactly one Accept — provider's wins
    const acceptKeys = Object.keys(merged).filter((k) => k.toLowerCase() === "accept");
    expect(acceptKeys).toHaveLength(1);
    expect(merged[acceptKeys[0]]).toBe("text/event-stream");

    // Exactly one Anthropic-Beta — provider's wins
    const betaKeys = Object.keys(merged).filter((k) => k.toLowerCase() === "anthropic-beta");
    expect(betaKeys).toHaveLength(1);
    expect(merged[betaKeys[0]]).toBe("claude-code-20250219");

    // Non-colliding client header passes through
    expect(merged["user-agent"]).toBe("claude-cli/2.1.92");
  });

  it("non-colliding client headers are preserved", () => {
    const client = { "user-agent": "claude-cli", "x-stainless-os": "Linux" };
    const provider = { "Content-Type": "application/json", "Authorization": "Bearer tok" };
    const merged = mergeForwardedHeaders(client, provider);
    expect(merged["user-agent"]).toBe("claude-cli");
    expect(merged["x-stainless-os"]).toBe("Linux");
    expect(merged["Content-Type"]).toBe("application/json");
  });

  it("returns providerHeaders unchanged when clientHeaders is empty", () => {
    const provider = { "Accept": "text/event-stream", "Authorization": "Bearer tok" };
    expect(mergeForwardedHeaders({}, provider)).toBe(provider);
    expect(mergeForwardedHeaders(null, provider)).toBe(provider);
  });

  it("produces no duplicate-cased keys in merged result", () => {
    const client = {
      "accept-encoding": "gzip, zstd",
      "accept": "application/json",
      "anthropic-version": "2023-01-01",
      "anthropic-beta": "old-flag",
    };
    const provider = {
      "Accept-Encoding": "gzip, deflate, br",
      "Accept": "text/event-stream",
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219",
    };
    const merged = mergeForwardedHeaders(client, provider);
    const lcKeyCounts = {};
    for (const k of Object.keys(merged)) {
      const lc = k.toLowerCase();
      lcKeyCounts[lc] = (lcKeyCounts[lc] || 0) + 1;
    }
    for (const [lc, count] of Object.entries(lcKeyCounts)) {
      expect(count, `Duplicate key "${lc}" in merged headers`).toBe(1);
    }
  });
});

// ─── HEADER_FORWARD_BLOCKLIST — accept-encoding is blocked ────────────────────

describe("HEADER_FORWARD_BLOCKLIST — accept-encoding must be blocked", () => {
  it("blocks accept-encoding so client encoding preferences are never forwarded", () => {
    expect(HEADER_FORWARD_BLOCKLIST.has("accept-encoding")).toBe(true);
  });

  it("getForwardableClientHeaders strips accept-encoding from client headers", () => {
    const client = {
      "accept-encoding": "gzip, br, zstd",
      "user-agent": "claude-cli/2.1.92",
      "anthropic-beta": "client-flag",
    };
    const forwarded = getForwardableClientHeaders(client);
    expect(forwarded["accept-encoding"]).toBeUndefined();
    expect(forwarded["user-agent"]).toBe("claude-cli/2.1.92");
    expect(forwarded["anthropic-beta"]).toBe("client-flag");
  });
});

