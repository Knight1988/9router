import { getUsageForProvider } from "./usage.js";

/**
 * Resolve the open-claude account's next quota reset as a ms epoch, or null
 * if it can't be determined (no creds, API failure, or reset already passed).
 *
 * Used by the chat rotation loop on a 402 to set a precise cooldown via
 * markAccountUnavailable's resetsAtMs path, so locked accounts are retried
 * at the actual quota reset rather than the generic 2-minute fallback.
 */
export async function getOpenClaudeResetsAtMs(connection) {
  if (!connection || connection.provider !== "open-claude") return null;
  try {
    const usage = await getUsageForProvider(connection);
    const quotas = usage?.quotas || {};
    const firstKey = Object.keys(quotas)[0];
    const resetAt = firstKey ? quotas[firstKey]?.resetAt : null;
    if (!resetAt) return null;
    const ms = new Date(resetAt).getTime();
    return Number.isFinite(ms) && ms > Date.now() ? ms : null;
  } catch {
    return null;
  }
}
