/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { CLIENT_METADATA, getPlatformUserAgent } from "../config/appConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// GitHub API config
const GITHUB_CONFIG = {
  apiVersion: "2022-11-28",
  userAgent: "GitHubCopilotChat/0.26.7",
};

// GLM quota endpoints (region-aware)
const GLM_QUOTA_URLS = {
  international: "https://api.z.ai/api/monitor/usage/quota/limit",
  china: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
};

// MiniMax usage endpoints (try in order, fallback on transient errors)
const MINIMAX_USAGE_URLS = {
  minimax: [
    "https://www.minimax.io/v1/token_plan/remains",
    "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  ],
  "minimax-cn": [
    "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
  ],
};

// Antigravity API config (from Quotio)
const ANTIGRAVITY_CONFIG = {
  quotaApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  userAgent: getPlatformUserAgent(),
};

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: "https://chatgpt.com/backend-api/wham/usage",
};

// Claude API config
const CLAUDE_CONFIG = {
  oauthUsageUrl: "https://api.anthropic.com/api/oauth/usage",
  usageUrl: "https://api.anthropic.com/v1/organizations/{org_id}/usage",
  settingsUrl: "https://api.anthropic.com/v1/settings",
  apiVersion: "2023-06-01",
};

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

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @param {Object} [options]
 * @param {Function} [options.onSessionRefreshed] - Called with { accessToken, expiresAt } when open-claude refreshes its session
 * @returns {Object} Usage data with quotas
 */
export async function getUsageForProvider(connection, options = {}) {
  const { onSessionRefreshed, ...proxyOptions } = typeof options === "object" && options !== null ? options : {};
  const proxyOpts = Object.keys(proxyOptions).length > 0 ? proxyOptions : null;
  const { provider, accessToken, apiKey, providerSpecificData } = connection;

  switch (provider) {
    case "github":
      return await getGitHubUsage(accessToken, providerSpecificData, proxyOpts);
    case "gemini-cli":
      return await getGeminiUsage(accessToken, providerSpecificData, proxyOpts);
    case "antigravity":
      return await getAntigravityUsage(accessToken, providerSpecificData, proxyOpts);
    case "claude":
      return await getClaudeUsage(accessToken, proxyOpts);
    case "codex":
      return await getCodexUsage(accessToken, proxyOpts);
    case "kiro":
      return await getKiroUsage(accessToken, providerSpecificData, proxyOpts);
    case "qwen":
      return await getQwenUsage(accessToken, providerSpecificData);
    case "iflow":
      return await getIflowUsage(accessToken);
    case "open-claude":
      return await getOpenClaudeUsage(connection, onSessionRefreshed);
    case "troll-llm":
      return await getTrollLlmUsage(accessToken);
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

/**
 * GitHub Copilot Usage
 * Uses GitHub accessToken (not copilotToken) to call copilot_internal/user API
 */
async function getGitHubUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    if (!accessToken) {
      throw new Error("No GitHub access token available. Please re-authorize the connection.");
    }

    // copilot_internal/user API requires GitHub OAuth token, not copilotToken
    const response = await proxyAwareFetch("https://api.github.com/copilot_internal/user", {
      headers: {
        "Authorization": `token ${accessToken}`,
        "Accept": "application/json",
        "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
        "User-Agent": GITHUB_CONFIG.userAgent,
        "Editor-Version": "vscode/1.100.0",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
      },
    }, proxyOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${error}`);
    }

    const data = await response.json();

    // Handle different response formats (paid vs free)
    if (data.quota_snapshots) {
      // Paid plan format
      const snapshots = data.quota_snapshots;
      const resetAt = parseResetTime(data.quota_reset_date);

      return {
        plan: data.copilot_plan,
        resetDate: data.quota_reset_date,
        quotas: {
          chat: { ...formatGitHubQuotaSnapshot(snapshots.chat), resetAt },
          completions: { ...formatGitHubQuotaSnapshot(snapshots.completions), resetAt },
          premium_interactions: { ...formatGitHubQuotaSnapshot(snapshots.premium_interactions), resetAt },
        },
      };
    } else if (data.monthly_quotas || data.limited_user_quotas) {
      // Free/limited plan format
      const monthlyQuotas = data.monthly_quotas || {};
      const usedQuotas = data.limited_user_quotas || {};
      const resetAt = parseResetTime(data.limited_user_reset_date);

      return {
        plan: data.copilot_plan || data.access_type_sku,
        resetDate: data.limited_user_reset_date,
        quotas: {
          chat: {
            used: usedQuotas.chat || 0,
            total: monthlyQuotas.chat || 0,
            unlimited: false,
            resetAt,
          },
          completions: {
            used: usedQuotas.completions || 0,
            total: monthlyQuotas.completions || 0,
            unlimited: false,
            resetAt,
          },
        },
      };
    }

    return { message: "GitHub Copilot connected. Unable to parse quota data." };
  } catch (error) {
    throw new Error(`Failed to fetch GitHub usage: ${error.message}`);
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

/**
 * Gemini CLI Usage — fetch per-model quota via Cloud Code Assist API.
 * Uses retrieveUserQuota (same endpoint as `gemini /stats`) returning
 * per-model buckets with remainingFraction + resetTime.
 */
async function getGeminiUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { plan: "Free", message: "Gemini CLI access token not available." };
  }

  try {
    // Resolve project id: prefer connection-stored id, else loadCodeAssist lookup
    let projectId = providerSpecificData?.projectId || null;
    let plan = "Free";

    if (!projectId) {
      const subInfo = await getGeminiSubscriptionInfo(accessToken, proxyOptions);
      projectId = subInfo?.cloudaicompanionProject || null;
      plan = subInfo?.currentTier?.name || plan;
    }

    if (!projectId) {
      return { plan, message: "Gemini CLI project ID not available." };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await proxyAwareFetch(
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ project: projectId }),
          signal: controller.signal,
        },
        proxyOptions
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return { plan, message: `Gemini CLI quota error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    if (Array.isArray(data.buckets)) {
      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;

        const remainingFraction = Number(bucket.remainingFraction) || 0;
        const total = 1000; // Normalized base, matches antigravity convention
        const remaining = Math.round(total * remainingFraction);
        const used = Math.max(0, total - remaining);

        quotas[bucket.modelId] = {
          used,
          total,
          resetAt: parseResetTime(bucket.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
        };
      }
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Gemini CLI error: ${error.message}` };
  }
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
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
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
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    // Fetch quota data with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    let response;
    try {
      response = await proxyAwareFetch(ANTIGRAVITY_CONFIG.quotaApiUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
          "Content-Type": "application/json",
          "X-Client-Name": "antigravity",
          "X-Client-Version": "1.107.0",
          "x-request-source": "local", // MITM bypass
        },
        body: JSON.stringify({
          ...(projectId ? { project: projectId } : {})
        }),
        signal: controller.signal,
      }, proxyOptions);
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {}
      };
    }

    if (response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {}
      };
    }

    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    const quotas = {};

    // Parse model quotas (inspired by vscode-antigravity-cockpit)
    if (data.models) {
      // Filter only recommended/important models (must match PROVIDER_MODELS ag ids)
      const importantModels = [
        'claude-opus-4-6-thinking',
        'claude-sonnet-4-6',
        'gemini-3.1-pro-high',
        'gemini-3.1-pro-low',
        'gemini-3-flash',
        'gpt-oss-120b-medium',
      ];

      for (const [modelKey, info] of Object.entries(data.models)) {
        // Skip models without quota info
        if (!info.quotaInfo) {
          continue;
        }

        // Skip internal models and non-important models
        if (info.isInternal || !importantModels.includes(modelKey)) {
          continue;
        }

        const remainingFraction = info.quotaInfo.remainingFraction || 0;
        const remainingPercentage = remainingFraction * 100;

        // Convert percentage to used/total for UI compatibility
        const total = 1000; // Normalized base
        const remaining = Math.round(total * remainingFraction);
        const used = total - remaining;

        // Use modelKey as key (matches PROVIDER_MODELS id)
        quotas[modelKey] = {
          used,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage,
          unlimited: false,
          displayName: info.displayName || modelKey,
        };
      }
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
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
  const res = await fetch(OPEN_CLAUDE_CONFIG.loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
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
 * Claude Usage - Primary: OAuth endpoint, Fallback: legacy settings/org endpoint
 */
async function getClaudeUsage(accessToken, proxyOptions = null) {
  try {
    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    const oauthResponse = await proxyAwareFetch(CLAUDE_CONFIG.oauthUsageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      return {
        plan: "Claude Code",
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
    }

    // Fallback: legacy settings + org usage endpoint
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    return await getClaudeUsageLegacy(accessToken, proxyOptions);
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
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

async function getCodexUsage(accessToken, proxyOptions = null) {
  try {
    const response = await proxyAwareFetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      return { message: `Codex connected. Usage API temporarily unavailable (${response.status}).` };
    }

    const data = await response.json();
    const normalRateLimit = data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex || {};
    const reviewRateLimit = getCodexReviewRateLimit(data);
    const quotas = {};

    appendCodexQuotaWindows(quotas, "", normalRateLimit);
    appendCodexQuotaWindows(quotas, "review", reviewRateLimit);

    return {
      plan: data.plan_type || data.summary?.plan || "unknown",
      limitReached: getCodexRateLimitBody(normalRateLimit)?.limit_reached || false,
      reviewLimitReached: getCodexRateLimitBody(reviewRateLimit)?.limit_reached || false,
      quotas,
    };
  } catch (error) {
    throw new Error(`Failed to fetch Codex usage: ${error.message}`);
  }
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

async function getKiroUsage(accessToken, providerSpecificData, proxyOptions = null) {
  // Default profileArn fallback
  const DEFAULT_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
  const profileArn = providerSpecificData?.profileArn || DEFAULT_PROFILE_ARN;
  const authMethod = providerSpecificData?.authMethod || "builder-id";

  const getUsageParams = new URLSearchParams({
    isEmailRequired: "true",
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
  });

  // For compatibility, try multiple known Kiro usage endpoints
  const attempts = [
    {
      name: "codewhisperer-get",
      run: async () => proxyAwareFetch(
        `https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?${getUsageParams.toString()}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json",
            "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE",
            "user-agent": "aws-sdk-js/1.0.0 KiroIDE",
          },
        },
        proxyOptions
      ),
    },
    {
      name: "codewhisperer-post",
      run: async () => proxyAwareFetch("https://codewhisperer.us-east-1.amazonaws.com", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          origin: "AI_EDITOR",
          profileArn,
          resourceType: "AGENTIC_REQUEST",
        }),
      }, proxyOptions),
    },
    {
      name: "q-get",
      run: async () => {
        const params = new URLSearchParams({
          origin: "AI_EDITOR",
          profileArn,
          resourceType: "AGENTIC_REQUEST",
        });
        return proxyAwareFetch(`https://q.us-east-1.amazonaws.com/getUsageLimits?${params}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json",
          },
        }, proxyOptions);
      },
    },
  ];

  let sawAuthError = false;
  const errors = [];

  for (const attempt of attempts) {
    try {
      const response = await attempt.run();
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          sawAuthError = true;
        }
        errors.push(`${attempt.name}:${response.status}${errorText ? `:${errorText}` : ""}`);
        continue;
      }

      const data = await response.json();
      return parseKiroQuotaData(data);
    } catch (error) {
      errors.push(`${attempt.name}:${error.message}`);
    }
  }

  if (sawAuthError && authMethod === "idc") {
    return {
      message: "Kiro quota API is unavailable for the current AWS IAM Identity Center session. Chat may still work. If this persists after renewing your session, reconnect Kiro.",
      quotas: {},
    };
  }

  // Social auth (Google/GitHub) - these use a different token format that may not work with AWS CodeWhisperer quota APIs
  if (sawAuthError && (authMethod === "google" || authMethod === "github")) {
    return {
      message: "Kiro quota API authentication expired. Chat may still work.",
      quotas: {},
    };
  }

  if (sawAuthError) {
    return {
      message: "Kiro quota API rejected the current token. Chat may still work.",
      quotas: {},
    };
  }

  const fallbackMessage =
    errors.length > 0
      ? `Unable to fetch Kiro usage right now. (${errors[errors.length - 1]})`
      : "Unable to fetch Kiro usage right now.";

  return {
    message: fallbackMessage,
    quotas: {},
  };
}

/**
 * Qwen Usage
 */
async function getQwenUsage(accessToken, providerSpecificData) {
  try {
    const resourceUrl = providerSpecificData?.resourceUrl;
    if (!resourceUrl) {
      return { message: "Qwen connected. No resource URL available." };
    }

    // Qwen may have usage endpoint at resource URL
    return { message: "Qwen connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch Qwen usage." };
  }
}

/**
 * iFlow Usage
 */
async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * DevGoVN Usage - Logs in with the API key, then fetches quota summary.
 * The quota page uses cookie-based session after POST /api/customer/login.
 */
async function getDevGoUsage(accessToken) {
  try {
    const baseUrl = DEVGO_CONFIG.baseUrl;

    const loginRes = await fetch(`${baseUrl}${DEVGO_CONFIG.loginPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: accessToken }),
    });

    if (!loginRes.ok) {
      throw new Error(`DevGoVN login failed: ${loginRes.status}`);
    }

    const cookieHeader = loginRes.headers.get("set-cookie") || "";
    const cookieValue = cookieHeader.split(";")[0].trim();

    const summaryRes = await fetch(`${baseUrl}${DEVGO_CONFIG.summaryPath}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(cookieValue ? { Cookie: cookieValue } : {}),
      },
    });

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

/**
 * Ollama Cloud Usage
 * Ollama Cloud uses an API key from ollama.com/settings/keys
 * and has no public usage API — free tier has light usage limits (resets every 5h & 7d).
 * This returns an informational message with the plan details.
 */
async function getOllamaUsage(accessToken, providerSpecificData) {
  try {
    // Ollama Cloud does not expose a public quota/usage API.
    // The provider is configured as noAuth with a notice explaining limits.
    // We return a graceful message so the UI shows a friendly state instead of an error.
    const plan = providerSpecificData?.plan || "Free";
    return {
      plan,
      message: "Ollama Cloud uses a free tier with light usage limits (resets every 5h & 7d). For detailed usage tracking, visit ollama.com/settings/keys.",
      quotas: [],
    };
  } catch (error) {
    return { message: "Unable to fetch Ollama Cloud usage." };
  }
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      if (!limit || limit.type !== "TOKENS_LIMIT") continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      quotas["session"] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

// ── MiniMax helpers ──────────────────────────────────────────────────────
function isMiniMaxTextQuotaModel(modelName) {
  const normalized = (modelName || "").trim().toLowerCase();
  return normalized.startsWith("minimax-m") || normalized.startsWith("coding-plan");
}

function getMiniMaxField(model, snakeKey, camelKey) {
  if (!model || typeof model !== "object") return null;
  return model[snakeKey] ?? model[camelKey] ?? null;
}

function getMiniMaxSessionTotal(model) {
  return Math.max(0, Number(getMiniMaxField(model, "current_interval_total_count", "currentIntervalTotalCount")) || 0);
}

function getMiniMaxWeeklyTotal(model) {
  return Math.max(0, Number(getMiniMaxField(model, "current_weekly_total_count", "currentWeeklyTotalCount")) || 0);
}

function pickMiniMaxRepresentativeModel(models, getTotal) {
  const withQuota = models.filter((m) => getTotal(m) > 0);
  const pool = withQuota.length > 0 ? withQuota : models;
  if (pool.length === 0) return null;
  return pool.reduce((best, current) => (getTotal(current) > getTotal(best) ? current : best));
}

function getMiniMaxResetAt(model, capturedAtMs, remainsSnake, remainsCamel, endSnake, endCamel) {
  const remainsMs = Number(getMiniMaxField(model, remainsSnake, remainsCamel)) || 0;
  if (remainsMs > 0) return new Date(capturedAtMs + remainsMs).toISOString();
  return parseResetTime(getMiniMaxField(model, endSnake, endCamel));
}

function buildMiniMaxQuota(total, count, resetAt, countMeansRemaining) {
  const safeTotal = Math.max(0, total);
  const used = countMeansRemaining ? Math.max(safeTotal - count, 0) : Math.min(Math.max(0, count), safeTotal);
  const remaining = Math.max(safeTotal - used, 0);
  return {
    used,
    total: safeTotal,
    remaining,
    remainingPercentage: safeTotal > 0 ? Math.max(0, Math.min(100, (remaining / safeTotal) * 100)) : 0,
    resetAt,
    unlimited: false,
  };
}

/**
 * MiniMax Token Plan / Coding Plan usage
 */
async function getMiniMaxUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "MiniMax API key not available." };
  }

  const usageUrls = MINIMAX_USAGE_URLS[provider] || [];
  let lastErrorMessage = "";

  for (let index = 0; index < usageUrls.length; index += 1) {
    const usageUrl = usageUrls[index];
    const canFallback = index < usageUrls.length - 1;

    try {
      const response = await proxyAwareFetch(usageUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }, proxyOptions);

      const rawText = await response.text();
      let payload = {};
      if (rawText) {
        try { payload = JSON.parse(rawText); } catch { payload = {}; }
      }

      const baseResp = (payload?.base_resp ?? payload?.baseResp) || {};
      const apiStatusCode = Number(baseResp.status_code ?? baseResp.statusCode) || 0;
      const apiStatusMessage = String(baseResp.status_msg ?? baseResp.statusMsg ?? "").trim();
      const combined = `${apiStatusMessage} ${rawText}`.trim();
      const authLike = /token plan|coding plan|invalid api key|invalid key|unauthorized|inactive/i;

      if (response.status === 401 || response.status === 403 || apiStatusCode === 1004 || authLike.test(combined)) {
        return { message: "MiniMax API key invalid or inactive. Use an active Token/Coding Plan key." };
      }

      if (!response.ok) {
        lastErrorMessage = `MiniMax usage endpoint error (${response.status})`;
        if ((response.status === 404 || response.status === 405 || response.status >= 500) && canFallback) continue;
        return { message: `MiniMax connected. ${lastErrorMessage}` };
      }

      if (apiStatusCode !== 0) {
        return { message: `MiniMax connected. ${apiStatusMessage || "Upstream quota API error"}` };
      }

      const modelRemains = payload?.model_remains ?? payload?.modelRemains;
      const allModels = Array.isArray(modelRemains) ? modelRemains : [];
      const textModels = allModels.filter((m) => isMiniMaxTextQuotaModel(String(getMiniMaxField(m, "model_name", "modelName"))));

      if (textModels.length === 0) {
        return { message: "MiniMax connected. No text quota data was returned." };
      }

      const capturedAtMs = Date.now();
      const countMeansRemaining = usageUrl.includes("/coding_plan/remains");
      const quotas = {};

      const sessionModel = pickMiniMaxRepresentativeModel(textModels, getMiniMaxSessionTotal);
      if (sessionModel) {
        const total = getMiniMaxSessionTotal(sessionModel);
        const count = Math.max(0, Number(getMiniMaxField(sessionModel, "current_interval_usage_count", "currentIntervalUsageCount")) || 0);
        quotas["session (5h)"] = buildMiniMaxQuota(
          total, count,
          getMiniMaxResetAt(sessionModel, capturedAtMs, "remains_time", "remainsTime", "end_time", "endTime"),
          countMeansRemaining
        );
      }

      const weeklyModel = pickMiniMaxRepresentativeModel(textModels, getMiniMaxWeeklyTotal);
      if (weeklyModel && getMiniMaxWeeklyTotal(weeklyModel) > 0) {
        const total = getMiniMaxWeeklyTotal(weeklyModel);
        const count = Math.max(0, Number(getMiniMaxField(weeklyModel, "current_weekly_usage_count", "currentWeeklyUsageCount")) || 0);
        quotas["weekly (7d)"] = buildMiniMaxQuota(
          total, count,
          getMiniMaxResetAt(weeklyModel, capturedAtMs, "weekly_remains_time", "weeklyRemainsTime", "weekly_end_time", "weeklyEndTime"),
          countMeansRemaining
        );
      }

      if (Object.keys(quotas).length === 0) {
        return { message: "MiniMax connected. Unable to extract quota usage." };
      }

      return { quotas };
    } catch (error) {
      lastErrorMessage = error.message;
      if (!canFallback) break;
    }
  }

  return { message: lastErrorMessage ? `MiniMax connected. Unable to fetch usage: ${lastErrorMessage}` : "MiniMax connected. Unable to fetch usage." };
}
