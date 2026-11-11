import { beforeEach, describe, expect, it, vi } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));
const xaiProvider = vi.hoisted(() => ({ config: {
  authorizeUrl: "https://auth.x.ai/oauth2/authorize",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  clientId: "test-client",
  scope: "openid profile email offline_access",
  codeChallengeMethod: "S256",
}, flowType: "authorization_code_pkce", pkceVerifierBytes: 96,
  prepareConfig: async (config) => {
    const response = await fetchMock("https://auth.x.ai/.well-known/openid-configuration", {
      headers: { Accept: "application/json" },
    });
    if (response?.ok) {
      const endpoints = await response.json();
      return {
        ...config,
        authorizeUrl: endpoints.authorization_endpoint,
        tokenUrl: endpoints.token_endpoint,
      };
    }
    return {
      ...config,
      authorizeUrl: "https://auth.x.ai/oauth2/authorize",
      tokenUrl: "https://auth.x.ai/oauth2/token",
    };
  },
  buildAuthUrl: (config, redirectUri, state, challenge) => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const query = new URLSearchParams({
      response_type: "code", client_id: "b1a00492-073a-47ea-816f-4c329264a828", redirect_uri: redirectUri,
      scope: config.scope, code_challenge: challenge, code_challenge_method: "S256",
      state, nonce: "0123456789abcdef0123456789abcdef", plan: "generic", referrer: "cli-proxy-api",
    });
    return `${config.authorizeUrl}?${query}`;
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  }),
  exchangeToken: async (config, code, redirectUri, verifier) => {
    const response = await fetchMock(config.tokenUrl, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    if (!response.ok) throw new Error(`xAI token exchange failed: ${await response.text()}`);
    return response.json();
  },
}));
vi.mock("../../src/lib/oauth/providers/xai.js", () => ({ default: xaiProvider }));
vi.mock("../../src/lib/oauth/providers.js", async () => {
  const actual = await vi.importActual("../../src/lib/oauth/providers.js");
  return { ...actual, getProvider: () => xaiProvider };
});


describe("xai/oauth service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("validates discovered endpoints are https x.ai URLs", async () => {
    const { validateOAuthEndpoint } = await import("../../src/lib/oauth/services/xai.js");

    expect(validateOAuthEndpoint("https://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toBe(
      "https://auth.x.ai/oauth2/authorize"
    );
    expect(() => validateOAuthEndpoint("http://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toThrow(
      /must use https/
    );
    expect(() => validateOAuthEndpoint("https://example.com/oauth2/authorize", "authorization_endpoint")).toThrow(
      /is not on x\.ai/
    );
  });

  it("discovers endpoints without custom user-agent headers", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }),
    });

    const fetchMockStart = fetchMock.mock.calls.length;
    const { discoverEndpoints } = await import("../../src/lib/oauth/services/xai.js");
    await expect(discoverEndpoints()).resolves.toEqual({
      authorizeUrl: "https://auth.x.ai/oauth2/authorize",
      tokenUrl: "https://auth.x.ai/oauth2/token",
    });
    expect(fetchMock.mock.calls[fetchMockStart]).toEqual([
      "https://auth.x.ai/.well-known/openid-configuration",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    ]);
  });

  it("builds authorize URLs with CLIProxyAPI query extras", async () => {
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");
    const authUrl = new XaiService().buildXaiAuthUrl(
      "http://127.0.0.1:56121/callback",
      "state-1",
      "challenge-1",
      "https://auth.x.ai/oauth2/authorize"
    );
    const parsed = new URL(authUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("generates dashboard auth data with CLIProxyAPI PKCE size and discovered endpoints", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }),
    });

    fetchMock.mockReset();
    const { generateAuthData } = await import("../../src/lib/oauth/providers.js");
    const data = await generateAuthData("xai", "http://127.0.0.1:56121/callback");
    const parsed = new URL(data.authUrl);

    expect(data.codeVerifier).toHaveLength(128);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("exchanges dashboard codes against the discovered xAI token endpoint", async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          token_endpoint: "https://auth.x.ai/oauth2/token-from-discovery",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }),
      });

    const { exchangeTokens } = await import("../../src/lib/oauth/providers.js");
    const tokens = await exchangeTokens(
      "xai",
      "auth-code",
      "http://127.0.0.1:56121/callback",
      "verifier-1",
      "state-1"
    );

    expect(fetchMock.mock.calls[1][0]).toBe("https://auth.x.ai/oauth2/token-from-discovery");
    expect(fetchMock.mock.calls[1][1].body.get("grant_type")).toBe("authorization_code");
    expect(fetchMock.mock.calls[1][1].body.get("code")).toBe("auth-code");
    expect(fetchMock.mock.calls[1][1].body.get("code_verifier")).toBe("verifier-1");
    expect(tokens).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    });
  });
});
