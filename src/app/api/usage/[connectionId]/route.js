// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
async function refreshAndUpdateCredentials(connection, force = false) {
  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method
  const refreshResult = await executor.refreshCredentials(credentials, console);

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  if (refreshResult.copilotToken || refreshResult.copilotTokenExpiresAt) {
    updateData.providerSpecificData = {
      ...connection.providerSpecificData,
      copilotToken: refreshResult.copilotToken,
      copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt,
    };
  }

  // Update database
  await updateProviderConnection(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const queryMonitorToken = request.nextUrl.searchParams.get("monitorToken")?.trim();

    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Use query param token, or fall back to saved monitor token from DB
    const monitorToken = queryMonitorToken
      || connection.providerSpecificData?.monitorToken || null;

    const usageSupported = USAGE_SUPPORTED_PROVIDERS.includes(connection.provider);

    if (!usageSupported) {
      return Response.json({ message: `Usage API not implemented for ${connection.provider}` });
    }

    // API-key providers can still expose usage dashboards. An optional monitor token
    // lets Open Claude use a dedicated bearer without changing the saved connection.
    // For open-claude, saved monitorCreds (username+password) also satisfy this check.
    const hasOpenClaudeMonitorCreds = connection.provider === "open-claude" && !!connection.providerSpecificData?.monitorCreds?.username;
    if (connection.authType !== "oauth" && !monitorToken && !connection.accessToken && !hasOpenClaudeMonitorCreds) {
      return Response.json({ message: "Usage not available for API key connections" });
    }

    // Refresh OAuth credentials when needed. API-key providers skip refresh.
    if (connection.authType === "oauth" && !monitorToken) {
      try {
        const result = await refreshAndUpdateCredentials(connection);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json({
          error: `Credential refresh failed: ${refreshError.message}`
        }, { status: 401 });
      }
    }

    // Override accessToken with monitor token when provided
    const effectiveConnection = monitorToken
      ? { ...connection, accessToken: monitorToken }
      : connection;

    // Persist a freshly obtained Open Claude session back to the DB
    const onSessionRefreshed = async (newSession) => {
      try {
        await updateProviderConnection(connection.id, {
          providerSpecificData: {
            ...connection.providerSpecificData,
            monitorSession: newSession,
          },
        });
      } catch (err) {
        console.warn("[Usage] Failed to persist open-claude session:", err.message);
      }
    };

    // Fetch usage from provider API
    let usage = await getUsageForProvider(effectiveConnection, { onSessionRefreshed });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (only for OAuth)
    if (isAuthExpiredMessage(usage) && connection.refreshToken && !monitorToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, { onSessionRefreshed });
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    return Response.json(usage);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
