/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Apply smart-routing priority ordering to models.
 * Uses the cached smartPriority list; falls back to original order if stale/empty.
 * @param {string[]} models - Original combo models
 * @param {string[]} [smartPriority] - Cached priority from scheduler
 * @returns {string[]}
 */
function applySmartPriority(models, smartPriority) {
  if (!smartPriority || smartPriority.length === 0) return models;

  // Keep only entries that still exist in the combo (defensive against edits)
  const modelSet = new Set(models);
  const ordered = smartPriority.filter((m) => modelSet.has(m));

  // Append any models not in smartPriority (new models added after last refresh)
  const orderedSet = new Set(ordered);
  for (const m of models) {
    if (!orderedSet.has(m)) ordered.push(m);
  }

  return ordered;
}

/**
 * Abortable sleep helper for inter-cycle delays
 * @param {number} ms - Milliseconds to sleep
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<void>}
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback", "round-robin", or "smart-routing"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching (round-robin only)
 * @param {string[]} [options.smartPriority] - Cached smart-routing priority order
 * @param {boolean} [options.keepCycling=false] - If true, restart from first model after exhausting all models
 * @param {AbortSignal} [options.signal] - Optional abort signal to stop cycling on client disconnect
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, smartPriority, keepCycling = false, signal }) {
  // Apply ordering strategy (computed once per request, before cycling)
  let rotatedModels;
  if (comboStrategy === "smart-routing") {
    rotatedModels = applySmartPriority(models, smartPriority);
    log.info("COMBO", `Smart routing order: [${rotatedModels.join(", ")}]`);
  } else {
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  }

  let lastError = null;
  let lastStatus = null;
  let earliestRetryAfter = null;

  const SAFETY_CAP = 200;
  // Exponential backoff between cycles: 1.5s → 3s → 6s → 12s → 24s → cap at 60s
  const CYCLE_DELAY_BASE_MS = 1500;
  const CYCLE_DELAY_MAX_MS = 60_000;
  let cycle = 0;

  while (true) {
    cycle++;
    earliestRetryAfter = null; // Reset each cycle for freshness

    for (let i = 0; i < rotatedModels.length; i++) {
      const modelStr = rotatedModels[i];
      log.info("COMBO", `Cycle ${cycle} | Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

      try {
        const result = await handleSingleModel(body, modelStr);

        // Success (2xx) - return response
        if (result.ok) {
          log.info("COMBO", `Cycle ${cycle} | Model ${modelStr} succeeded`);
          return result;
        }

        // Extract error info from response
        let errorText = result.statusText || "";
        let retryAfter = null;
        try {
          const errorBody = await result.clone().json();
          errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
          retryAfter = errorBody?.retryAfter || null;
        } catch {
          // Ignore JSON parse errors
        }

        // Track earliest retryAfter across all combo models
        if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
          earliestRetryAfter = retryAfter;
        }

        // Normalize error text to string (Worker-safe)
        if (typeof errorText !== "string") {
          try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
        }

        // Check if should fallback to next model
        const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);

        if (!shouldFallback) {
          log.warn("COMBO", `Cycle ${cycle} | Model ${modelStr} failed (no fallback)`, { status: result.status });
          return result;
        }

        // For transient errors (503/502/504), wait for cooldown before falling through
        // so a briefly-overloaded provider gets a chance to recover rather than being
        // skipped immediately (fixes: combo falls through on transient 503)
        if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
            (result.status === 503 || result.status === 502 || result.status === 504)) {
          log.info("COMBO", `Cycle ${cycle} | Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
          await new Promise(r => setTimeout(r, cooldownMs));
        }

        // Fallback to next model
        lastError = errorText || String(result.status);
        if (!lastStatus) lastStatus = result.status;
        log.warn("COMBO", `Cycle ${cycle} | Model ${modelStr} failed, trying next`, { status: result.status });
      } catch (error) {
        // Catch unexpected exceptions to ensure fallback continues
        lastError = error.message || String(error);
        if (!lastStatus) lastStatus = 500;
        log.warn("COMBO", `Cycle ${cycle} | Model ${modelStr} threw error, trying next`, { error: lastError });
      }

      // Check for abort mid-cycle
      if (signal?.aborted) {
        log.info("COMBO", `Cycle ${cycle} | Client disconnected, stopping`);
        break;
      }
    }

    // After full pass through all models
    if (!keepCycling) break;
    if (signal?.aborted) break;
    if (cycle >= SAFETY_CAP) {
      log.warn("COMBO", `Safety cap reached (${SAFETY_CAP} cycles), stopping`);
      break;
    }

    // Exponential backoff: 1.5s → 3s → 6s → 12s → 24s → 60s cap
    const cycleDelayMs = Math.min(CYCLE_DELAY_BASE_MS * Math.pow(2, cycle - 1), CYCLE_DELAY_MAX_MS);
    log.warn("COMBO", `🔄 [RETRY] Cycle ${cycle} exhausted — all ${rotatedModels.length} models failed. Restarting Cycle ${cycle + 1} after ${cycleDelayMs}ms (backoff)`);
    await abortableSleep(cycleDelayMs, signal);
    if (signal?.aborted) break;
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
