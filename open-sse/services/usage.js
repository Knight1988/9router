/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { getGitHubUsage } from "./usage/github.js";
import { getGeminiUsage, getAntigravityUsage } from "./usage/google.js";
import { getClaudeUsage } from "./usage/claude.js";
import { getCodexUsage, consumeCodexRateLimitResetCredit } from "./usage/codex.js";

export { consumeCodexRateLimitResetCredit };
import { getKiroUsage } from "./usage/kiro.js";
import { getMiniMaxUsage } from "./usage/minimax.js";
import {
  getQwenUsage,
  getIflowUsage,
  getOllamaUsage,
  getGlmUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
} from "./usage/misc.js";
import { CLIENT_METADATA, getPlatformUserAgent } from "../config/appConstants.js";
import { fetchWithRetry } from "../utils/retry.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { resolveDefaultProfileArn } from "../config/kiroConstants.js";

const OPEN_CLAUDE_CONFIG = {
  overviewUrl: "https://open-claude.com/api/dashboard/overview",
  loginUrl: "https://open-claude.com/api/auth/login",
};

const TROLL_LLM_CONFIG = {
  profileUrl: "https://www.trollllm.xyz/api/user/me",
  billingUrl: "https://www.trollllm.xyz/api/user/billing",
  usageStatusUrl: "https://www.trollllm.xyz/api/user/usage/status",
};

const DEVGO_CONFIG = {
  baseUrl: "https://quota.9router.tools.devgovietnam.io.vn",
  loginPath: "/api/customer/login",
  summaryPath: "/api/customer/summary",
};

const CLAUDIBLE_CONFIG = {
  lookupUrl: "https://claudible.io/dashboard/lookup",
};

const TECHOPENCLAW_CONFIG = {
  infoUrl: "https://api.techopenclaw.com/v1/user/info",
};

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @param {Object} [options]
 * @param {Function} [options.onSessionRefreshed] - Called with { accessToken, expiresAt } when open-claude refreshes its session
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
const USAGE_HANDLERS = {
  github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
  antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions),
  codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
  kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  qoder: (c) => getQoderUsage(c.accessToken, c.proxyOptions),
  qwen: (c) => getQwenUsage(c.accessToken, c.providerSpecificData),
  iflow: (c) => getIflowUsage(c.accessToken),
  ollama: (c) => getOllamaUsage(c.accessToken),
  glm: (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  "glm-cn": (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
};

export async function getUsageForProvider(connection, options = {}) {
  const { onSessionRefreshed, ...proxyOptions } = typeof options === "object" && options !== null ? options : {};
  const proxyOpts = Object.keys(proxyOptions).length > 0 ? proxyOptions : null;
  const { provider, accessToken, apiKey, providerSpecificData, projectId } = connection;
  const providerDataWithProjectId = {
    ...(providerSpecificData || {}),
    ...(projectId ? { projectId } : {}),
  };

  switch (provider) {
    case "github":
      return await getGitHubUsage(accessToken, providerSpecificData, proxyOpts);
    case "gemini-cli":
      return await getGeminiUsage(accessToken, providerDataWithProjectId, proxyOpts);
    case "antigravity":
      return await getAntigravityUsage(accessToken, providerSpecificData, proxyOpts);
    case "claude":
      return await getClaudeUsage(accessToken, proxyOpts);
    case "codex":
      return await getCodexUsage(accessToken, proxyOpts);
    case "kiro":
      return await getKiroUsage(accessToken, providerSpecificData, proxyOpts);
    case "qoder":
      return await getQoderUsage(accessToken, proxyOpts);
    case "qwen":
      return await getQwenUsage(accessToken, providerSpecificData);
    case "iflow":
      return await getIflowUsage(accessToken);
    case "open-claude":
      return await getOpenClaudeUsage(connection, onSessionRefreshed);
    case "troll-llm":
      return await getTrollLlmUsage(accessToken);
    case "techopenclaw":
      return await getTechOpenClawUsage(apiKey, proxyOpts);
    case "devgo":
      return await getDevGoUsage(accessToken);
    case "ollama":
      return await getOllamaUsage(accessToken);
    case "glm":
    case "glm-cn":
      return await getGlmUsage(apiKey, provider, proxyOptions);
    case "minimax":
    case "minimax-cn":
      return await getMiniMaxUsage(apiKey, provider, proxyOptions);
    case "vip-claudible":
    case "cc-claudible":
    case "cn-claudible":
    case "minimax-claudible":
    case "claude-claudible":
    case "codex-claudible":
      return await getClaudibleUsage(apiKey, proxyOptions);
    case "vercel-ai-gateway":
      return await getVercelAiGatewayUsage(apiKey, proxyOptions);
    default:
      return { message: `Usage API not implemented for ${provider}` };
  }
}

/**
 * Parse reset date/time to ISO string
 * Handles multiple formats: Unix timestamp (ms), ISO date string, etc.
 */
function parseResetTime(resetValue) {
  if (!resetValue) return null;

  try {
    // If it's already a Date object
    if (resetValue instanceof Date) {
      return resetValue.toISOString();
    }

    // Unix timestamps from provider APIs may be seconds or milliseconds.
    if (typeof resetValue === 'number') {
      return new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue).toISOString();
    }

    // If it's a numeric string, treat it like a Unix timestamp too.
    if (typeof resetValue === 'string') {
      if (/^\d+$/.test(resetValue)) {
        const timestamp = Number(resetValue);
        return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
      }
      return new Date(resetValue).toISOString();
    }

    return null;
  } catch (error) {
    console.warn(`Failed to parse reset time: ${resetValue}`, error);
    return null;
  }
}

function formatGitHubQuotaSnapshot(quota) {
  if (!quota) return { used: 0, total: 0, unlimited: true };

  return {
    used: quota.entitlement - quota.remaining,
    total: quota.entitlement,
    remaining: quota.remaining,
    unlimited: quota.unlimited || false,
  };
}

function normalizeCloudCodeProjectId(project) {
  if (typeof project === "string") return project.trim() || null;
  if (project && typeof project === "object" && typeof project.id === "string") {
    return project.id.trim() || null;
  }
  return null;
}

/**
 * Get Gemini CLI subscription info via loadCodeAssist
 */
async function getGeminiSubscriptionInfo(accessToken, proxyOptions = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await proxyAwareFetch(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: CLIENT_METADATA,
        }),
        signal: controller.signal,
      },
      proxyOptions
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get Antigravity project ID from subscription info
 */
async function getAntigravityProjectId(accessToken) {
  try {
    const info = await getAntigravitySubscriptionInfo(accessToken);
    return info?.cloudaicompanionProject || null;
  } catch {
    return null;
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const response = await proxyAwareFetch(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "x-request-source": "local", // MITM bypass
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
      signal: controller.signal,
    }, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Log in to Open Claude with username + password.
 * Returns { accessToken, expiresAt } or throws on failure.
 */
async function loginOpenClaude(username, password) {
  const { result: res } = await fetchWithRetry(OPEN_CLAUDE_CONFIG.loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }, { maxRetries: 2, baseDelay: 1000 });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg;
    try { msg = JSON.parse(body)?.error || body; } catch { msg = body; }
    throw new Error(msg || `Login failed: ${res.status}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("Login succeeded but no token returned");
  return {
    accessToken: data.token,
    expiresAt: data.expiresAt ? parseResetTime(data.expiresAt) : null,
  };
}

/**
 * Resolve bearer for Open Claude usage requests.
 *
 * Priority:
 *  1. Cached session in providerSpecificData.monitorSession (if not within 60s of expiry)
 *  2. Fresh login from providerSpecificData.monitorCreds
 *  3. Legacy one-time monitorToken (providerSpecificData.monitorToken)
 *  4. connection.accessToken
 *
 * Returns { bearer, newSession } where newSession is non-null when a fresh login occurred
 * and should be persisted by the caller.
 */
async function resolveOpenClaudeBearer(connection) {
  const psd = connection.providerSpecificData || {};
  const { monitorSession, monitorCreds, monitorToken } = psd;

  // 1. Valid cached session
  if (monitorSession?.accessToken) {
    const expiresMs = monitorSession.expiresAt ? new Date(monitorSession.expiresAt).getTime() : Infinity;
    if (Date.now() < expiresMs - 60_000) {
      return { bearer: monitorSession.accessToken, newSession: null };
    }
  }

  // 2. Login with stored credentials
  if (monitorCreds?.username && monitorCreds?.password) {
    const session = await loginOpenClaude(monitorCreds.username, monitorCreds.password);
    return { bearer: session.accessToken, newSession: session };
  }

  // 3. Legacy one-time monitor token (backwards compatibility)
  if (monitorToken) {
    return { bearer: monitorToken, newSession: null };
  }

  // 4. Connection-level access token
  if (connection.accessToken) {
    return { bearer: connection.accessToken, newSession: null };
  }

  throw new Error("No credentials available for Open Claude usage monitoring. Enter a username and password in the Usage settings.");
}

/**
 * Open Claude Usage - Fetches budget/quota from dashboard API and proxy/usage for reset time.
 * Accepts optional onSessionRefreshed(newSession) callback to persist the cached bearer.
 */
async function getOpenClaudeUsage(connection, onSessionRefreshed) {
  try {
    let bearer, newSession;
    try {
      ({ bearer, newSession } = await resolveOpenClaudeBearer(connection));
    } catch (credErr) {
      return { message: `Open Claude: ${credErr.message}` };
    }

    const headers = {
      "Authorization": `Bearer ${bearer}`,
      "Content-Type": "application/json",
    };

    const fetchDashboard = async (hdrs) => {
      const [overviewRes, usageRes] = await Promise.all([
        fetch(OPEN_CLAUDE_CONFIG.overviewUrl, { method: "GET", headers: hdrs }),
        fetch("https://open-claude.com/api/proxy/usage?range=7d", { method: "GET", headers: hdrs }).catch(() => null),
      ]);
      return { overviewRes, usageRes };
    };

    let { overviewRes, usageRes } = await fetchDashboard(headers);

    // On 401/403, try a fresh login once (only when credentials are available)
    if ((overviewRes.status === 401 || overviewRes.status === 403) && connection.providerSpecificData?.monitorCreds?.username) {
      try {
        const refreshed = await loginOpenClaude(
          connection.providerSpecificData.monitorCreds.username,
          connection.providerSpecificData.monitorCreds.password,
        );
        newSession = refreshed;
        const retryHeaders = { "Authorization": `Bearer ${refreshed.accessToken}`, "Content-Type": "application/json" };
        ({ overviewRes, usageRes } = await fetchDashboard(retryHeaders));
      } catch {
        // swallow – surface original error below
      }
    }

    // Persist fresh session after successful fetch (and after any retry)
    if (newSession && typeof onSessionRefreshed === "function" && overviewRes.ok) {
      onSessionRefreshed(newSession);
    }

    if (!overviewRes.ok) {
      throw new Error(`Open Claude API error: ${overviewRes.status}`);
    }

    const data = await overviewRes.json();
    const usageData = usageRes?.ok ? await usageRes.json().catch(() => null) : null;
    const user = data.user || {};
    const quotas = {};

    const planType = usageData?.plan_type;
    const planAllowance = usageData?.plan_allowance;
    const periodUsed = usageData?.period_used_quota;
    const planPeriod = usageData?.plan_period || "2h";

    let totalDollars, usedDollars;
    if (planType === "reset" && planAllowance > 0 && periodUsed !== undefined) {
      totalDollars = planAllowance / 500000;
      usedDollars = periodUsed / 500000;
    } else {
      totalDollars = user.quota ? user.quota / 500000 : 0;
      usedDollars = user.periodUsedQuota ? user.periodUsedQuota / 500000 : 0;
    }
    const remainingDollars = Math.max(0, totalDollars - usedDollars);

    const resetAt = parseResetTime(usageData?.period_reset_at || null);

    const quotaLabel = `budget (${planPeriod})`;
    quotas[quotaLabel] = {
      used: +usedDollars.toFixed(2),
      total: +totalDollars.toFixed(2),
      remaining: +remainingDollars.toFixed(2),
      remainingPercentage: totalDollars > 0 ? Math.round((remainingDollars / totalDollars) * 100) : 0,
      resetAt,
      unlimited: !!user.isUnlimited,
      unit: "$",
    };

    return {
      plan: usageData?.plan_name || user.group || "Open Claude",
      planExpiresAt: data.planExpiresAt ? parseResetTime(data.planExpiresAt) : null,
      quotas,
    };
  } catch (error) {
    return { message: `Open Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

async function getTrollLlmUsage(accessToken) {
  try {
    const headers = {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    const [profileRes, billingRes, usageStatusRes] = await Promise.all([
      fetch(TROLL_LLM_CONFIG.profileUrl, { method: "GET", headers }),
      fetch(TROLL_LLM_CONFIG.billingUrl, { method: "GET", headers }).catch(() => null),
      fetch(TROLL_LLM_CONFIG.usageStatusUrl, { method: "GET", headers }).catch(() => null),
    ]);

    if (!profileRes.ok) {
      throw new Error(`Troll LLM API error: ${profileRes.status}`);
    }

    const profile = await profileRes.json();
    const billing = billingRes?.ok ? await billingRes.json().catch(() => null) : null;
    const usageStatus = usageStatusRes?.ok ? await usageStatusRes.json().catch(() => null) : null;
    const quotas = {};

    const totalDaily = Number(profile.planDailyAllocation ?? billing?.planDailyAllocation ?? 0);
    const usedDaily = Number(profile.planDailyUsed ?? billing?.planDailyUsed ?? 0);
    const remainingDaily = Math.max(0, totalDaily - usedDaily);
    // Troll LLM returns the *last* reset timestamp in planDailyResetDate. Roll it
    // forward by whole days so the countdown reflects the *next* reset, matching
    // what the official trollllm.xyz dashboard displays.
    const rawDailyReset = profile.planDailyResetDate || billing?.planDailyResetDate || null;
    let dailyResetAt = parseResetTime(rawDailyReset);
    if (dailyResetAt) {
      const now = Date.now();
      let resetMs = new Date(dailyResetAt).getTime();
      if (Number.isFinite(resetMs) && resetMs <= now) {
        const dayMs = 24 * 60 * 60 * 1000;
        resetMs += Math.ceil((now - resetMs) / dayMs) * dayMs;
        dailyResetAt = new Date(resetMs).toISOString();
      }
    }

    if (totalDaily > 0 || usedDaily > 0) {
      quotas["daily budget"] = {
        used: +usedDaily.toFixed(2),
        total: +totalDaily.toFixed(2),
        remaining: +remainingDaily.toFixed(2),
        remainingPercentage: totalDaily > 0 ? Math.round((remainingDaily / totalDaily) * 100) : 0,
        resetAt: dailyResetAt,
        unit: "$",
      };
    }

    const totalCredits = Number(profile.credits ?? billing?.credits ?? 0);
    const usedCredits = Number(profile.creditsUsed ?? billing?.creditsUsed ?? 0);
    const remainingCredits = Math.max(0, totalCredits - usedCredits);

    if (totalCredits > 0 || usedCredits > 0) {
      quotas.credits = {
        used: +usedCredits.toFixed(2),
        total: +totalCredits.toFixed(2),
        remaining: +remainingCredits.toFixed(2),
        remainingPercentage: totalCredits > 0 ? Math.round((remainingCredits / totalCredits) * 100) : 0,
        resetAt: null,
        unit: "$",
      };
    }

    if (usageStatus?.rpm?.limit) {
      quotas.rpm = {
        used: Number(usageStatus.rpm.used ?? 0),
        total: Number(usageStatus.rpm.limit ?? 0),
        remaining: Number(usageStatus.rpm.remaining ?? 0),
        remainingPercentage: usageStatus.rpm.limit > 0
          ? Math.round(((usageStatus.rpm.remaining ?? 0) / usageStatus.rpm.limit) * 100)
          : 0,
        resetAt: null,
        unit: "req",
      };
    }

    return {
      plan: profile.tier || billing?.tier || "Troll LLM",
      planExpiresAt: profile.planExpiresAt ? parseResetTime(profile.planExpiresAt) : null,
      quotas,
    };
  } catch (error) {
    return { message: `Troll LLM connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Codex (OpenAI) Usage - Fetch from ChatGPT backend API
 */
function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getCodexRateLimitBody(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return snapshot.rate_limit && typeof snapshot.rate_limit === "object"
    ? snapshot.rate_limit
    : snapshot;
}

function formatCodexWindow(window) {
  const used = Math.max(0, Math.min(100, toFiniteNumber(window?.used_percent ?? window?.percent_used, 0)));
  return {
    used,
    total: 100,
    remaining: Math.max(0, 100 - used),
    resetAt: parseResetTime(window?.reset_at ?? window?.resets_at ?? window?.resetAt ?? null),
    unlimited: false,
  };
}

function appendCodexQuotaWindows(quotas, prefix, snapshot) {
  const rateLimit = getCodexRateLimitBody(snapshot);
  if (!rateLimit) return false;

  const primary = rateLimit.primary_window || rateLimit.primary || snapshot.primary_window || snapshot.primary;
  const secondary = rateLimit.secondary_window || rateLimit.secondary || snapshot.secondary_window || snapshot.secondary;
  let added = false;

  if (primary) {
    quotas[prefix ? `${prefix}_session` : "session"] = formatCodexWindow(primary);
    added = true;
  }
  if (secondary) {
    quotas[prefix ? `${prefix}_weekly` : "weekly"] = formatCodexWindow(secondary);
    added = true;
  }

  return added;
}

function getCodexReviewRateLimit(data) {
  if (data.code_review_rate_limit || data.review_rate_limit) {
    return data.code_review_rate_limit || data.review_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId.code_review || byLimitId.codex_review || byLimitId.review || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id === "code_review" || id === "codex_review" || id === "review" || id.includes("review");
  }) || null;
}

/**
 * Kiro (AWS CodeWhisperer) Usage
 */
function parseKiroQuotaData(data) {
  const usageList = data.usageBreakdownList || [];
  const quotaInfo = {};
  const resetAt = parseResetTime(data.nextDateReset || data.resetDate);

  usageList.forEach((breakdown) => {
    const resourceType = breakdown.resourceType?.toLowerCase() || "unknown";
    const used = breakdown.currentUsageWithPrecision || 0;
    const total = breakdown.usageLimitWithPrecision || 0;

    quotaInfo[resourceType] = {
      used,
      total,
      remaining: total - used,
      resetAt,
      unlimited: false,
    };

    // Add free trial if available
    if (breakdown.freeTrialInfo) {
      const freeUsed = breakdown.freeTrialInfo.currentUsageWithPrecision || 0;
      const freeTotal = breakdown.freeTrialInfo.usageLimitWithPrecision || 0;

      quotaInfo[`${resourceType}_freetrial`] = {
        used: freeUsed,
        total: freeTotal,
        remaining: freeTotal - freeUsed,
        resetAt: parseResetTime(breakdown.freeTrialInfo.freeTrialExpiry || resetAt),
        unlimited: false,
      };
    }
  });

  return {
    plan: data.subscriptionInfo?.subscriptionTitle || "Kiro",
    quotas: quotaInfo,
  };
}

/**
 * DevGoVN Usage - Logs in with the API key, then fetches quota summary.
 * The quota page uses cookie-based session after POST /api/customer/login.
 */
async function getDevGoUsage(accessToken) {
  try {
    const baseUrl = DEVGO_CONFIG.baseUrl;

    const { result: loginRes } = await fetchWithRetry(`${baseUrl}${DEVGO_CONFIG.loginPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: accessToken }),
    }, { maxRetries: 2, baseDelay: 1000 });

    if (!loginRes.ok) {
      throw new Error(`DevGoVN login failed: ${loginRes.status}`);
    }

    const cookieHeader = loginRes.headers.get("set-cookie") || "";
    const cookieValue = cookieHeader.split(";")[0].trim();

    const { result: summaryRes } = await fetchWithRetry(`${baseUrl}${DEVGO_CONFIG.summaryPath}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(cookieValue ? { Cookie: cookieValue } : {}),
      },
    }, { maxRetries: 2, baseDelay: 1000 });

    if (!summaryRes.ok) {
      throw new Error(`DevGoVN summary API error: ${summaryRes.status}`);
    }

    const body = await summaryRes.json();
    const data = body.data || body;
    const quota = data.quota || {};
    const usage = data.usage || {};

    const quotas = {};

    const budgetUsd = quota.isUnlimited ? null : (quota.budgetUsd || 0);
    const usedUsd = quota.effectiveUsedUsd ?? quota.usedUsd ?? 0;
    const remainingUsd = quota.remainingUsd ?? (budgetUsd != null ? Math.max(0, budgetUsd - usedUsd) : 0);

    quotas["budget"] = {
      used: +usedUsd.toFixed(4),
      total: budgetUsd != null ? +budgetUsd.toFixed(4) : 0,
      remaining: +Math.max(0, remainingUsd).toFixed(4),
      remainingPercentage: budgetUsd > 0 ? Math.round((remainingUsd / budgetUsd) * 100) : 0,
      resetAt: null,
      unlimited: !!quota.isUnlimited,
      unit: "$",
    };

    if (quota.cycleBudgetUsd > 0) {
      const cycleUsed = quota.cycleUsedUsd || 0;
      const cycleBudget = quota.cycleBudgetUsd;
      const cycleRemaining = Math.max(0, cycleBudget - cycleUsed);
      quotas[`cycle (${quota.resetIntervalHours || 24}h)`] = {
        used: +cycleUsed.toFixed(4),
        total: +cycleBudget.toFixed(4),
        remaining: +cycleRemaining.toFixed(4),
        remainingPercentage: cycleBudget > 0 ? Math.round((cycleRemaining / cycleBudget) * 100) : 0,
        resetAt: quota.nextResetAt ? parseResetTime(quota.nextResetAt) : null,
        unlimited: false,
        unit: "$",
      };
    }

    return {
      plan: quota.creditTier || "DevGoVN",
      quotas,
    };
  } catch (error) {
    return { message: `DevGoVN connected. Unable to fetch usage: ${error.message}` };
  }
}

// ── MiniMax helpers ──────────────────────────────────────────────────────
function getMiniMaxField(model, snakeKey, camelKey) {
  if (!model || typeof model !== "object") return null;
  return model[snakeKey] ?? model[camelKey] ?? null;
}

function getMiniMaxModelName(model) {
  return String(getMiniMaxField(model, "model_name", "modelName") || "").trim();
}

function formatMiniMaxQuotaName(model) {
  const rawName = getMiniMaxModelName(model);
  if (!rawName) return "MiniMax";

  // M3+ shared quota pool: MiniMax reports M-series as a single wildcard
  // bucket ("MiniMax-M*"). Newer responses rename it to plain "general".
  // Render both as a friendly series label rather than leaking the
  // asterisk or the vague "general" word to the UI.
  if (rawName === "MiniMax-M*" || rawName === "general") return "M-series";

  return rawName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .replace(/\bTo\b/g, "to")
    .replace(/\bTts\b/g, "TTS")
    .replace(/\bHd\b/g, "HD");
}

function getMiniMaxProvidedPercent(model, snakeKey, camelKey) {
  if (!model || typeof model !== "object") return null;
  const raw = model[snakeKey] ?? model[camelKey];
  if (raw === null || raw === undefined) return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function getMiniMaxSessionTotal(model) {
  return Math.max(0, Number(getMiniMaxField(model, "current_interval_total_count", "currentIntervalTotalCount")) || 0);
}

function getMiniMaxWeeklyTotal(model) {
  return Math.max(0, Number(getMiniMaxField(model, "current_weekly_total_count", "currentWeeklyTotalCount")) || 0);
}

function hasMiniMaxQuota(model) {
  // Old format has real count totals; M3-era M-series buckets ship percent-only
  // (count fields are 0) so accept those too.
  if (getMiniMaxSessionTotal(model) > 0 || getMiniMaxWeeklyTotal(model) > 0) return true;
  if (getMiniMaxProvidedPercent(model, "current_interval_remaining_percent", "currentIntervalRemainingPercent") !== null) return true;
  if (getMiniMaxProvidedPercent(model, "current_weekly_remaining_percent", "currentWeeklyRemainingPercent") !== null) return true;
  return false;
}

function getMiniMaxResetAt(model, capturedAtMs, remainsSnake, remainsCamel, endSnake, endCamel) {
  const remainsMs = Number(getMiniMaxField(model, remainsSnake, remainsCamel)) || 0;
  if (remainsMs > 0) return new Date(capturedAtMs + remainsMs).toISOString();
  return parseResetTime(getMiniMaxField(model, endSnake, endCamel));
}

function buildMiniMaxQuota(total, count, resetAt, countMeansRemaining, providedPercent = null) {
  const safeTotal = Math.max(0, total);
  const used = countMeansRemaining ? Math.max(safeTotal - count, 0) : Math.min(Math.max(0, count), safeTotal);
  const remaining = Math.max(safeTotal - used, 0);
  // M-series buckets ship percent-only (count = 0). Prefer the upstream value
  // when present, otherwise fall back to the computed percentage. When the
  // quota is unbounded (no count) and no upstream percent is available, surface
  // the percent anyway as long as it is defined.
  const remainingPercentage = providedPercentage(providedPercent, remaining, safeTotal);
  return {
    used,
    total: safeTotal,
    remaining,
    remainingPercentage,
    resetAt,
    unlimited: false,
  };
}

function providedPercentage(provided, remaining, total) {
  if (provided !== null && provided !== undefined && Number.isFinite(provided)) {
    return Math.max(0, Math.min(100, provided));
  }
  return total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
}

function addMiniMaxQuota(quotas, key, model, getTotal, countSnake, countCamel, percentSnake, percentCamel, resetArgs, countMeansRemaining) {
  const total = getTotal(model);
  const providedPercent = getMiniMaxProvidedPercent(model, percentSnake, percentCamel);
  if (total <= 0 && providedPercent === null) return;

  const count = Math.max(0, Number(getMiniMaxField(model, countSnake, countCamel)) || 0);
  let effectiveTotal = total;
  let effectiveCount = count;
  if (total <= 0) {
    // M-series bucket: API only ships *_remaining_percent (count = 0). Normalize
    // to total=100. The downstream buildMiniMaxQuota treats the count as
    // "used" or "remaining" depending on countMeansRemaining, so the synthetic
    // count has to match that semantic — otherwise the UI flips the percentage.
    effectiveTotal = 100;
    const pct = providedPercent;
    effectiveCount = countMeansRemaining
      ? Math.round(effectiveTotal * (pct / 100))
      : Math.round(effectiveTotal * (1 - pct / 100));
  }
  quotas[key] = buildMiniMaxQuota(
    effectiveTotal,
    effectiveCount,
    getMiniMaxResetAt(model, ...resetArgs),
    countMeansRemaining,
    providedPercent
  );
}

/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
/**
 * Techopenclaw Usage - Fetches daily plan quota and top-up wallet via user/info API.
 * The API key is used directly as a Bearer token (same value returned by /v1/user/login).
 */
async function getTechOpenClawUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Techopenclaw API key not available." };
  }

  try {
    const response = await proxyAwareFetch(TECHOPENCLAW_CONFIG.infoUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        Referer: "https://techopenclaw.com/",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Techopenclaw API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Techopenclaw usage API error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    const dailyLimit = Number(data.daily_limit ?? data.plan?.daily_limit ?? 0);
    const dailyUsed = Number(data.plan_used_today ?? data.daily_used ?? 0);
    const planRemaining = Number(data.plan_remaining ?? data.plan?.daily_remaining ?? Math.max(0, dailyLimit - dailyUsed));
    const resetInSeconds = Number(data.plan?.reset_in_seconds ?? 0);
    const planResetAt = resetInSeconds > 0
      ? new Date(Date.now() + resetInSeconds * 1000).toISOString()
      : null;

    quotas["plan (rolling)"] = {
      used: +dailyUsed.toFixed(4),
      total: +dailyLimit.toFixed(4),
      remaining: +planRemaining.toFixed(4),
      remainingPercentage: dailyLimit > 0 ? Math.round((planRemaining / dailyLimit) * 100) : 0,
      resetAt: planResetAt,
      unlimited: false,
      unit: "credit",
    };

    const topupTotal = Number(data.total_topup ?? 0);
    const topupUsed = Number(data.topup_credits ?? 0);
    const topupBalance = Number(data.topup_balance ?? Math.max(0, topupTotal - topupUsed));

    if (topupTotal > 0 || topupUsed > 0) {
      quotas["top-up credits"] = {
        used: +topupUsed.toFixed(4),
        total: +topupTotal.toFixed(4),
        remaining: +topupBalance.toFixed(4),
        remainingPercentage: topupTotal > 0 ? Math.round((topupBalance / topupTotal) * 100) : 0,
        resetAt: null,
        unlimited: false,
        unit: "credit",
      };
    }

    return {
      plan: data.plan?.name || "Techopenclaw",
      planExpiresAt: data.plan?.expires_at ? parseResetTime(data.plan.expires_at) : null,
      quotas,
    };
  } catch (error) {
    return { message: `Techopenclaw connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Get Claudible usage (VIP, CC, CN, MiniMax, Claude Claudible)
 */
async function getClaudibleUsage(apiKey, proxyOptions = null) {
  try {
    const response = await proxyAwareFetch(
      CLAUDIBLE_CONFIG.lookupUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey }),
      },
      proxyOptions
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        error: `Claudible API error: ${response.status} ${response.statusText}`,
        details: errorText,
      };
    }

    const data = await response.json();

    if (!data.valid) {
      return { error: "Invalid API key" };
    }

    // Parse subscription expiration
    const subscriptionExpiresAt = data.subscriptionExpiresAt
      ? parseResetTime(data.subscriptionExpiresAt)
      : null;

    const dailyQuota = data.dailyQuota;
    const balance = data.balance;
    const quotas = {};
    // Claudible daily quota resets at midnight Asia/Ho_Chi_Minh (UTC+7), i.e. 17:00 UTC.
    const now = new Date();
    const resetAt = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      17, 0, 0, 0,
    ));
    if (resetAt.getTime() <= now.getTime()) {
      resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    }
    const dailyResetAt = resetAt.toISOString();
    if (typeof dailyQuota === "number" && dailyQuota > 0 && typeof balance === "number") {
      const used = Math.max(0, dailyQuota - balance);
      quotas["Daily Quota"] = {
        used,
        total: dailyQuota,
        remainingPercentage: Math.max(0, Math.min(100, (balance / dailyQuota) * 100)),
        resetAt: dailyResetAt,
      };
    }

    return {
      balance,
      dailyQuota,
      dailyResetAt,
      quotas,
      accountType: data.accountType,
      status: data.status,
      subscriptionActive: data.subscriptionActive,
      subscriptionExpiresAt,
      totalRequests: data.stats?.totalRequests || 0,
      totalCost: data.stats?.totalCost || 0,
      userEmail: data.userEmail,
      userName: data.userName,
    };
  } catch (error) {
    return {
      error: `Failed to fetch Claudible usage: ${error.message}`,
    };
  }
}