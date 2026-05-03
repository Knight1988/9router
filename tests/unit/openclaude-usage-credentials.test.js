/**
 * Unit tests for open-claude quota tracking via username + password.
 *
 * Covers:
 *  - Valid cached session is reused without hitting the login endpoint
 *  - Expired/absent session triggers loginOpenClaude and calls onSessionRefreshed
 *  - 401 from dashboard re-logins once and retries
 *  - Missing creds with no accessToken returns a friendly message
 *  - Legacy monitorToken fallback still works
 *  - Legacy connection.accessToken fallback still works
 *  - Password is not present in the getUsageForProvider return value
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUsageForProvider } from "../../open-sse/services/usage.js";

const OVERVIEW_URL = "https://open-claude.com/api/dashboard/overview";
const USAGE_URL_BASE = "https://open-claude.com/api/proxy/usage";
const LOGIN_URL = "https://open-claude.com/api/auth/login";

function makeOverviewResponse(overrides = {}) {
  return {
    user: { quota: 1000000, periodUsedQuota: 500000, isUnlimited: false, group: "pro" },
    planExpiresAt: null,
    ...overrides,
  };
}

function makeUsageResponse(overrides = {}) {
  return {
    plan_type: "reset",
    plan_allowance: 1000000,
    period_used_quota: 500000,
    plan_period: "2h",
    period_reset_at: new Date(Date.now() + 7200000).toISOString(),
    plan_name: "Pro",
    ...overrides,
  };
}

function makeLoginResponse(token = "session-token-abc", expiresIn = 3600) {
  return {
    token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

function makeFetchOk(data) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data), text: () => Promise.resolve(JSON.stringify(data)) });
}

function makeFetchFail(status, body = "") {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}), text: () => Promise.resolve(body) });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("getUsageForProvider – open-claude credentials flow", () => {
  it("uses cached session when not expired, no login call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockImplementation((url) => {
      if (url === OVERVIEW_URL) return makeFetchOk(makeOverviewResponse());
      if (url.startsWith(USAGE_URL_BASE)) return makeFetchOk(makeUsageResponse());
      if (url === LOGIN_URL) throw new Error("login should not be called");
      return makeFetchFail(404);
    });

    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: {
        monitorCreds: { username: "user1", password: "pass1" },
        monitorSession: {
          accessToken: "cached-bearer",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    };

    const result = await getUsageForProvider(connection);
    expect(result.quotas).toBeDefined();

    const loginCalls = fetchSpy.mock.calls.filter(([url]) => url === LOGIN_URL);
    expect(loginCalls).toHaveLength(0);

    const overviewCalls = fetchSpy.mock.calls.filter(([url]) => url === OVERVIEW_URL);
    expect(overviewCalls).toHaveLength(1);
    const authHeader = overviewCalls[0][1]?.headers?.Authorization;
    expect(authHeader).toBe("Bearer cached-bearer");
  });

  it("logins when session is expired, calls onSessionRefreshed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onSessionRefreshed = vi.fn();

    fetchSpy.mockImplementation((url) => {
      if (url === LOGIN_URL) return makeFetchOk(makeLoginResponse("fresh-bearer"));
      if (url === OVERVIEW_URL) return makeFetchOk(makeOverviewResponse());
      if (url.startsWith(USAGE_URL_BASE)) return makeFetchOk(makeUsageResponse());
      return makeFetchFail(404);
    });

    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: {
        monitorCreds: { username: "user1", password: "pass1" },
        monitorSession: {
          accessToken: "stale-bearer",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    };

    const result = await getUsageForProvider(connection, { onSessionRefreshed });
    expect(result.quotas).toBeDefined();

    const loginCalls = fetchSpy.mock.calls.filter(([url]) => url === LOGIN_URL);
    expect(loginCalls).toHaveLength(1);

    const overviewCalls = fetchSpy.mock.calls.filter(([url]) => url === OVERVIEW_URL);
    expect(overviewCalls).toHaveLength(1);
    const authHeader = overviewCalls[0][1]?.headers?.Authorization;
    expect(authHeader).toBe("Bearer fresh-bearer");

    expect(onSessionRefreshed).toHaveBeenCalledOnce();
    expect(onSessionRefreshed.mock.calls[0][0].accessToken).toBe("fresh-bearer");
  });

  it("logins when no session present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onSessionRefreshed = vi.fn();

    fetchSpy.mockImplementation((url) => {
      if (url === LOGIN_URL) return makeFetchOk(makeLoginResponse("new-bearer"));
      if (url === OVERVIEW_URL) return makeFetchOk(makeOverviewResponse());
      if (url.startsWith(USAGE_URL_BASE)) return makeFetchOk(makeUsageResponse());
      return makeFetchFail(404);
    });

    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: {
        monitorCreds: { username: "user1", password: "pass1" },
      },
    };

    const result = await getUsageForProvider(connection, { onSessionRefreshed });
    expect(result.quotas).toBeDefined();
    expect(onSessionRefreshed).toHaveBeenCalledOnce();
  });

  it("re-logins once on 401 from overview and retries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onSessionRefreshed = vi.fn();
    let overviewCallCount = 0;

    fetchSpy.mockImplementation((url) => {
      if (url === LOGIN_URL) return makeFetchOk(makeLoginResponse("retry-bearer"));
      if (url === OVERVIEW_URL) {
        overviewCallCount++;
        if (overviewCallCount === 1) return makeFetchFail(401, "Unauthorized");
        return makeFetchOk(makeOverviewResponse());
      }
      if (url.startsWith(USAGE_URL_BASE)) return makeFetchOk(makeUsageResponse());
      return makeFetchFail(404);
    });

    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: {
        monitorCreds: { username: "user1", password: "pass1" },
        monitorSession: {
          accessToken: "expired-bearer",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    };

    const result = await getUsageForProvider(connection, { onSessionRefreshed });
    expect(result.quotas).toBeDefined();
    expect(overviewCallCount).toBe(2);
    expect(onSessionRefreshed).toHaveBeenCalledOnce();
  });

  it("returns friendly message when no credentials and no accessToken", async () => {
    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: {},
    };

    const result = await getUsageForProvider(connection);
    expect(result.message).toMatch(/credentials/i);
    expect(result.quotas).toBeUndefined();
  });

  it("falls back to legacy monitorToken when creds absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockImplementation((url) => {
      if (url === OVERVIEW_URL) return makeFetchOk(makeOverviewResponse());
      if (url.startsWith(USAGE_URL_BASE)) return makeFetchOk(makeUsageResponse());
      if (url === LOGIN_URL) throw new Error("login should not be called");
      return makeFetchFail(404);
    });

    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: { monitorToken: "legacy-bearer" },
    };

    const result = await getUsageForProvider(connection);
    expect(result.quotas).toBeDefined();

    const overviewCalls = fetchSpy.mock.calls.filter(([url]) => url === OVERVIEW_URL);
    expect(overviewCalls[0][1]?.headers?.Authorization).toBe("Bearer legacy-bearer");
  });

  it("falls back to connection.accessToken when creds and monitorToken absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockImplementation((url) => {
      if (url === OVERVIEW_URL) return makeFetchOk(makeOverviewResponse());
      if (url.startsWith(USAGE_URL_BASE)) return makeFetchOk(makeUsageResponse());
      return makeFetchFail(404);
    });

    const connection = {
      provider: "open-claude",
      accessToken: "direct-bearer",
      providerSpecificData: {},
    };

    const result = await getUsageForProvider(connection);
    expect(result.quotas).toBeDefined();

    const overviewCalls = fetchSpy.mock.calls.filter(([url]) => url === OVERVIEW_URL);
    expect(overviewCalls[0][1]?.headers?.Authorization).toBe("Bearer direct-bearer");
  });

  it("return value does not contain password", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockImplementation((url) => {
      if (url === LOGIN_URL) return makeFetchOk(makeLoginResponse("tok"));
      if (url === OVERVIEW_URL) return makeFetchOk(makeOverviewResponse());
      if (url.startsWith(USAGE_URL_BASE)) return makeFetchOk(makeUsageResponse());
      return makeFetchFail(404);
    });

    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: {
        monitorCreds: { username: "user1", password: "supersecret" },
      },
    };

    const result = await getUsageForProvider(connection);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("supersecret");
  });

  it("login failure returns friendly message and does not throw", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (url === LOGIN_URL) return makeFetchFail(400, '{"error":"Invalid username or password"}');
      return makeFetchFail(500);
    });

    const connection = {
      provider: "open-claude",
      accessToken: null,
      providerSpecificData: { monitorCreds: { username: "bad", password: "wrong" } },
    };

    const result = await getUsageForProvider(connection);
    expect(result.message).toMatch(/invalid username or password/i);
    expect(result.quotas).toBeUndefined();
  });
});
