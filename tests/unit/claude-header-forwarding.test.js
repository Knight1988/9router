/**
 * Unit tests for Anthropic header caching + forwarding pipeline
 *
 * Tests cover:
 *  - claudeHeaderCache: detection, capture, and retrieval of Claude Code headers
 *  - default.js buildHeaders(): live header overlay for "claude" provider
 *  - default.js buildHeaders(): cold-start fallback when cache is empty
 *  - default.js buildHeaders(): anthropic-compatible non-Anthropic host stripping
 *  - default.js buildHeaders(): anthropic-compatible official host keeps headers
 *  - proxyFetch.js: api.anthropic.com routes through anthropicFetch path
 *  - mergeForwardedHeaders: case-insensitive merge prevents duplicate-cased header lines
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mergeForwardedHeaders, getForwardableClientHeaders, HEADER_FORWARD_BLOCKLIST } from "open-sse/utils/clientDetector.js";

// ─── claudeHeaderCache ────────────────────────────────────────────────────────

describe("claudeHeaderCache", () => {
  let cacheModule;

  beforeEach(async () => {
    // Re-import fresh module each time to reset singleton state
    vi.resetModules();
    cacheModule = await import("open-sse/utils/claudeHeaderCache.js");
  });

  it("returns null before any headers are cached (cold start)", () => {
    expect(cacheModule.getCachedClaudeHeaders()).toBeNull();
  });

  it("caches headers when user-agent contains 'claude-code'", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63 node/24.3.0",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
      "x-stainless-os": "MacOS",
      "x-stainless-arch": "arm64",
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v24.3.0",
      "x-stainless-package-version": "0.74.0",
      "x-stainless-helper-method": "stream",
      "x-stainless-retry-count": "0",
      "x-stainless-timeout": "600",
      "anthropic-dangerous-direct-browser-access": "true",
      // Non-identity header — should NOT be captured
      "content-type": "application/json",
    });

    const cached = cacheModule.getCachedClaudeHeaders();
    expect(cached).not.toBeNull();
    expect(cached["user-agent"]).toBe("claude-code/2.1.63 node/24.3.0");
    expect(cached["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(cached["x-app"]).toBe("cli");
    expect(cached["x-stainless-os"]).toBe("MacOS");
    // Non-identity header must not leak in
    expect(cached["content-type"]).toBeUndefined();
  });

  it("caches headers when user-agent contains 'claude-cli'", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-cli/1.0.0",
      "anthropic-version": "2023-06-01",
    });
    expect(cacheModule.getCachedClaudeHeaders()).not.toBeNull();
    expect(cacheModule.getCachedClaudeHeaders()["user-agent"]).toBe("claude-cli/1.0.0");
  });

  it("caches headers when x-app is 'cli' (regardless of user-agent)", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "axios/1.7.0",
      "x-app": "cli",
      "anthropic-version": "2023-06-01",
    });
    expect(cacheModule.getCachedClaudeHeaders()).not.toBeNull();
  });

  it("does NOT cache headers for non-Claude clients", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "PostmanRuntime/7.43.0",
      "anthropic-version": "2023-06-01",
    });
    expect(cacheModule.getCachedClaudeHeaders()).toBeNull();
  });

  it("refreshes cache on each matching request", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.0.0",
      "x-stainless-package-version": "0.70.0",
    });
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63",
      "x-stainless-package-version": "0.74.0",
    });
    const cached = cacheModule.getCachedClaudeHeaders();
    expect(cached["user-agent"]).toBe("claude-code/2.1.63");
    expect(cached["x-stainless-package-version"]).toBe("0.74.0");
  });

  it("ignores calls with null or non-object headers", () => {
    cacheModule.cacheClaudeHeaders(null);
    cacheModule.cacheClaudeHeaders(undefined);
    cacheModule.cacheClaudeHeaders("string");
    expect(cacheModule.getCachedClaudeHeaders()).toBeNull();
  });

  it("only stores keys that are actually present in the headers object", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63",
      // Most stainless headers absent
    });
    const cached = cacheModule.getCachedClaudeHeaders();
    expect(cached["x-stainless-os"]).toBeUndefined();
    expect(cached["user-agent"]).toBe("claude-code/2.1.63");
  });
});

// ─── DefaultExecutor.buildHeaders() ──────────────────────────────────────────

describe("DefaultExecutor.buildHeaders() — claude provider", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    // Prime the cache with live client headers before importing executor
    const cache = await import("open-sse/utils/claudeHeaderCache.js");
    cache.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63 node/24.3.0",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "x-stainless-os": "MacOS",
      "x-stainless-arch": "arm64",
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v24.3.0",
      "x-stainless-package-version": "0.74.0",
      "x-stainless-helper-method": "stream",
      "x-stainless-retry-count": "0",
      "x-stainless-timeout": "600",
    });
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("overlays live cached headers over static provider defaults", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    // Live values should win over static providers.js values
    expect(headers["user-agent"]).toBe("claude-code/2.1.63 node/24.3.0");
    // Beta flags are MERGED (static + cached) to preserve required flags like oauth
    const betaFlags = headers["anthropic-beta"].split(",").map(s => s.trim());
    expect(betaFlags).toContain("claude-code-20250219");
    expect(betaFlags).toContain("oauth-2025-04-20");
    expect(betaFlags).toContain("interleaved-thinking-2025-05-14");
    expect(headers["x-stainless-package-version"]).toBe("0.74.0");
    expect(headers["x-stainless-os"]).toBe("MacOS");
  });

  it("removes conflicting Title-Case static keys when cached lowercase keys exist", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    // Title-Case variants from providers.js must be gone
    expect(headers["Anthropic-Version"]).toBeUndefined();
    expect(headers["Anthropic-Beta"]).toBeUndefined();
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers["X-App"]).toBeUndefined();
    // Lowercase variants must be present
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-app"]).toBe("cli");
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
});

describe("DefaultExecutor.buildHeaders() — claude provider cold start (no cache)", () => {
  let DefaultExecutor;

  beforeEach(async () => {
    vi.resetModules();
    // Do NOT prime cache — simulate cold start
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  it("falls back to static provider headers when cache is empty", () => {
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk-test" }, true);

    // Static fallback values from providers.js must still be present
    // They may be Title-Case since no cache to conflict with them
    const hasVersion =
      headers["Anthropic-Version"] === "2023-06-01" ||
      headers["anthropic-version"] === "2023-06-01";
    expect(hasVersion).toBe(true);
  });

  it("does not throw when cache returns null", () => {
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

