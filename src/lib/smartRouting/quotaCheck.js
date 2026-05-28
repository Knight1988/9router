import { getProviderConnections, getCombos } from "@/lib/localDb";
import { USAGE_SUPPORTED_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { fetchUsageForConnection, bestRemainingPercentage } from "@/lib/usage/connectionUsage";
import { expandComboModels } from "open-sse/services/combo.js";
import { applyHealthScoring } from "./healthTracker.js";

/**
 * Parse a model string (e.g. "kr/claude-sonnet-4.5" or "glm/glm-5.1") to a provider id.
 * Handles alias prefixes using ALIAS_TO_ID.
 * Returns null if it cannot be resolved to a known provider.
 */
function modelStringToProviderId(modelStr) {
  if (!modelStr || !modelStr.includes("/")) return null;
  const [alias] = modelStr.split("/");
  return ALIAS_TO_ID[alias] || alias;
}

/**
 * Check whether a provider supports quota checks.
 */
export function isProviderQuotaSupported(modelStr) {
  const providerId = modelStringToProviderId(modelStr);
  if (!providerId) return false;
  return USAGE_SUPPORTED_PROVIDERS.includes(providerId);
}

/**
 * Build a combo lookup function from the DB for use with expandComboModels.
 */
async function buildComboLookup() {
  const combos = await getCombos();
  const map = new Map(combos.map(c => [c.name, c]));
  return (name) => map.get(name) ?? null;
}

/**
 * Expand a combo's models to leaf provider/model strings, resolving sub-combos recursively.
 * @param {{ models: string[] }} combo
 * @returns {Promise<string[]>}
 */
async function expandCombo(combo) {
  const lookupCombo = await buildComboLookup();
  const leaves = [];
  const seen = new Set();
  for (const entry of (combo.models || [])) {
    const expanded = await expandComboModels(entry, lookupCombo, new Set(), seen);
    leaves.push(...expanded);
  }
  return leaves;
}

/**
 * Validate that all leaf models in a combo (including sub-combos) can have quota checked.
 * @param {{ models: string[] }} combo
 * @returns {Promise<{ ok: boolean, unsupported: string[] }>}
 */
export async function validateComboForSmartRouting(combo) {
  const leaves = await expandCombo(combo);
  const unsupported = leaves.filter((m) => !isProviderQuotaSupported(m));
  return { ok: unsupported.length === 0, unsupported };
}

/**
 * Fetch the best remaining-quota percentage for a single model string.
 * Uses the best active connection for the model's provider.
 * @param {string} modelStr
 * @returns {Promise<{ ok: boolean, percent: number|null, reason?: string }>}
 */
export async function getProviderQuotaPercentForModel(modelStr) {
  const providerId = modelStringToProviderId(modelStr);
  if (!providerId) return { ok: false, percent: null, reason: "Cannot resolve provider" };

  if (!USAGE_SUPPORTED_PROVIDERS.includes(providerId)) {
    return { ok: false, percent: null, reason: `${providerId} does not support quota checks` };
  }

  let connections;
  try {
    const all = await getProviderConnections();
    connections = (all || []).filter(
      (c) => c.provider === providerId && (c.isActive ?? true)
    );
  } catch (err) {
    return { ok: false, percent: null, reason: `Failed to load connections: ${err.message}` };
  }

  if (connections.length === 0) {
    return { ok: false, percent: null, reason: `No active connections for ${providerId}` };
  }

  let bestPercent = null;
  let lastReason = "No quota data returned";

  for (const conn of connections) {
    try {
      const usage = await fetchUsageForConnection(conn);
      const pct = bestRemainingPercentage(usage);
      if (pct !== null) {
        bestPercent = bestPercent === null ? pct : Math.max(bestPercent, pct);
      } else {
        lastReason = usage?.message || "No quota data";
      }
    } catch (err) {
      lastReason = err.message;
    }
  }

  if (bestPercent !== null) return { ok: true, percent: bestPercent };
  return { ok: false, percent: null, reason: lastReason };
}

/**
 * Compute a smart-priority ordering for the combo's models (with sub-combo expansion).
 * Leaf models with higher remaining quota come first. Original order preserved for ties.
 * @param {{ name: string, models: string[] }} combo
 * @returns {Promise<{ ok: boolean, priority: string[], errors: { model: string, reason: string }[] }>}
 */
export async function computeSmartPriority(combo) {
  const models = await expandCombo(combo);
  const results = await Promise.all(
    models.map(async (m) => {
      const r = await getProviderQuotaPercentForModel(m);
      return { model: m, percent: r.percent, ok: r.ok, reason: r.reason };
    })
  );

  const errors = results.filter((r) => !r.ok).map((r) => ({ model: r.model, reason: r.reason }));

  // Apply health scoring: demotes models with high empty_completion/error rates
  const sorted = applyHealthScoring(results);

  if (sorted.some((r) => r.healthStats && !r.healthStats.insufficientData)) {
    const summary = sorted.map((r) => `${r.model}(health=${r.healthScore?.toFixed(2) ?? "?"},quota=${r.percent ?? "?"}%)`).join(", ");
    console.log(`[SmartRouting] Health-adjusted priority: ${summary}`);
  }

  return {
    ok: errors.length === 0,
    priority: sorted.map((r) => r.model),
    errors,
  };
}
