import { updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];

function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  const executor = getExecutor(connection.provider);
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    providerSpecificData: connection.providerSpecificData,
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  const needsRefresh = force || executor.needsRefresh(credentials);
  if (!needsRefresh) return { connection, refreshed: false };

  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);
  if (!refreshResult) {
    if (connection.accessToken) return { connection, refreshed: false };
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  const now = new Date().toISOString();
  const updateData = { updatedAt: now };
  if (refreshResult.accessToken) updateData.accessToken = refreshResult.accessToken;
  if (refreshResult.refreshToken) updateData.refreshToken = refreshResult.refreshToken;
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }
  if (refreshResult.copilotToken || refreshResult.copilotTokenExpiresAt) {
    updateData.providerSpecificData = {
      ...connection.providerSpecificData,
      copilotToken: refreshResult.copilotToken,
      copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt,
    };
  }

  await updateProviderConnection(connection.id, updateData);
  return { connection: { ...connection, ...updateData }, refreshed: true };
}

/**
 * Fetch usage for a single connection, handling OAuth refresh, monitor tokens, etc.
 * Mirrors the logic in /api/usage/[connectionId]/route.js GET handler.
 * Returns a usage object (may include { quotas, message, plan, ... }) or throws.
 */
export async function fetchUsageForConnection(connection) {
  const { USAGE_APIKEY_PROVIDERS } = await import("@/shared/constants/providers");
  const { provider } = connection;
  const monitorToken = connection.providerSpecificData?.monitorToken || null;

  const isOAuth = connection.authType === "oauth";
  const isApikeyEligible = connection.authType === "apikey" && USAGE_APIKEY_PROVIDERS.includes(provider);
  const hasOpenClaudeMonitorCreds = provider === "open-claude" && !!connection.providerSpecificData?.monitorCreds?.username;
  const providerUsesApiKeyForUsage = ["troll-llm", "devgo"].includes(provider) && !!connection.apiKey;

  if (!isOAuth && !isApikeyEligible && !monitorToken && !connection.accessToken && !hasOpenClaudeMonitorCreds && !providerUsesApiKeyForUsage) {
    return { message: "Usage not available for this connection" };
  }

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  if (isOAuth && !monitorToken) {
    try {
      const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
      connection = result.connection;
    } catch (refreshError) {
      throw new Error(`Credential refresh failed: ${refreshError.message}`);
    }
  }

  const effectiveConnection = monitorToken
    ? { ...connection, accessToken: monitorToken }
    : providerUsesApiKeyForUsage && !connection.accessToken
      ? { ...connection, accessToken: connection.apiKey }
      : connection;

  const onSessionRefreshed = async (newSession) => {
    try {
      await updateProviderConnection(connection.id, {
        providerSpecificData: { ...connection.providerSpecificData, monitorSession: newSession },
      });
    } catch {
      // non-fatal
    }
  };

  let usage = await getUsageForProvider(effectiveConnection, { onSessionRefreshed, ...proxyOptions });

  if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken && !monitorToken) {
    try {
      const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
      connection = retryResult.connection;
      usage = await getUsageForProvider(connection, { onSessionRefreshed, ...proxyOptions });
    } catch {
      // keep whatever usage we have
    }
  }

  return usage;
}

/**
 * Compute the best remaining-quota percentage for a connection.
 * Returns a number 0-100 (higher = more quota), or null if no quota data.
 */
export function bestRemainingPercentage(usage) {
  if (!usage) return null;
  const quotas = usage.quotas;
  if (!quotas) return null;

  const values = Object.values(quotas).map((q) => {
    if (q.unlimited) return 100;
    if (typeof q.remainingPercentage === "number") return q.remainingPercentage;
    if (typeof q.total === "number" && q.total > 0 && typeof q.used === "number") {
      return Math.max(0, Math.min(100, ((q.total - q.used) / q.total) * 100));
    }
    return null;
  }).filter((v) => v !== null);

  if (values.length === 0) return null;
  return Math.max(...values);
}
