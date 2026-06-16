/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";
import { addJitter, abortableSleep } from "../utils/retry.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);


// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  const sorted = models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);

  // If no reordering happened, return the original array reference (saves allocation, allows toBe checks).
  if (sorted.every((m, i) => m === models[i])) return models;
  return sorted;
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Last array item whose role is "user" (current turn), or the last item when no
// role is present. History media (older turns) must not pin the combo to a vision
// model — those get stripped + placeholdered downstream instead.
function lastUserItem(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!arr[i]?.role || arr[i].role === "user") return arr[i];
  }
  return arr[arr.length - 1];
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "file" || t === "document" || t === "input_file") required.add("pdf");
    // gemini parts: inlineData/fileData carry a mime
    const mime = b.inlineData?.mimeType || b.fileData?.mimeType;
    if (typeof mime === "string" && mime.startsWith("image/")) required.add("vision");
    if (mime === "application/pdf") required.add("pdf");
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  // Modalities: current user turn only (last item across each known shape).
  const lastMsg = lastUserItem(body.messages);     // openai / claude
  if (lastMsg) scanContent(lastMsg.content);
  const lastInput = lastUserItem(body.input);      // responses
  if (lastInput) scanContent(lastInput.content);
  const contents = body.contents || body.request?.contents; // gemini / antigravity
  const lastContent = lastUserItem(contents);
  if (lastContent) scanContent(lastContent.parts);

  // search: detect web_search tool type in the request
  if (Array.isArray(body.tools)) {
    const SEARCH_TOOL_TYPES = new Set(["web_search", "web_search_preview", "brave_search", "serper_search"]);
    if (body.tools.some((t) => t && SEARCH_TOOL_TYPES.has(t.type))) required.add("search");
  }

  return required;
}

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
 * Recursively expand a model string into a flat list of leaf provider/model entries.
 *
 * A "leaf" is any string that contains "/" (e.g. "anthropic/claude-3-5-sonnet").
 * A "sub-combo" is any string without "/" that matches a known combo name.
 * Strings without "/" that don't match any combo are treated as leaves (aliases).
 *
 * Cycle detection: if a combo name is encountered a second time in the same
 * expansion path, it is skipped with a warning and contributes no leaves.
 *
 * Deduplication: first occurrence of each leaf wins; subsequent duplicates are dropped.
 *
 * @param {string} modelStr - Model string to expand
 * @param {function(string): (Object|null|Promise<Object|null>)} lookupCombo
 *   Sync or async function that returns a combo object (with .models) by name, or null.
 * @param {Set<string>} [visited] - Combo names already on the current expansion path (cycle guard)
 * @param {Set<string>} [seen] - Leaf strings already emitted (dedup across the whole expansion)
 * @returns {Promise<string[]>} Flat, deduped list of leaf model strings
 */
export async function expandComboModels(modelStr, lookupCombo, visited = new Set(), seen = new Set()) {
  // Already a provider/model leaf
  if (modelStr.includes("/")) {
    if (seen.has(modelStr)) return [];
    seen.add(modelStr);
    return [modelStr];
  }

  // Look up as a combo
  const combo = await lookupCombo(modelStr);
  if (!combo) {
    // Not a known combo — treat as alias leaf
    if (seen.has(modelStr)) return [];
    seen.add(modelStr);
    return [modelStr];
  }

  // Cycle detection
  if (visited.has(modelStr)) {
    console.warn(`[combo] Cycle detected: "${modelStr}" already on expansion path [${[...visited].join(" → ")}]. Skipping.`);
    return [];
  }

  // Known combo with no models contributes nothing
  if (!combo.models || combo.models.length === 0) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(modelStr);

  const results = [];
  for (const entry of combo.models) {
    const leaves = await expandComboModels(entry, lookupCombo, nextVisited, seen);
    results.push(...leaves);
  }
  return results;
}

/**
 * Get combo models from combos data, with recursive sub-combo expansion.
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {Promise<string[]|null>} Flat deduped array of leaf models, or null if not a combo
 */
export async function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;

  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);

  // Build a fast name→combo map
  const comboMap = new Map(combos.map(c => [c.name, c]));

  const topCombo = comboMap.get(modelStr);
  if (!topCombo || !topCombo.models || topCombo.models.length === 0) return null;

  const leaves = await expandComboModels(modelStr, (name) => comboMap.get(name) ?? null);
  return leaves.length > 0 ? leaves : null;
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
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, smartPriority, keepCycling = false, signal, autoSwitch = true }) {
  // Apply ordering strategy (computed once per request, before cycling)
  let rotatedModels;
  if (comboStrategy === "smart-routing") {
    rotatedModels = applySmartPriority(models, smartPriority);
    log.info("COMBO", `Smart routing order: [${rotatedModels.join(", ")}]`);
  } else {
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  }

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
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

    // Exponential backoff: 1.5s → 3s → 6s → 12s → 24s → 60s cap (full jitter for wide spread)
    const rawCycleDelayMs = Math.min(CYCLE_DELAY_BASE_MS * Math.pow(2, cycle - 1), CYCLE_DELAY_MAX_MS);
    const cycleDelayMs = addJitter(rawCycleDelayMs, { mode: 'full' });
    log.warn("COMBO", `🔄 [RETRY] Cycle ${cycle} exhausted — all ${rotatedModels.length} models failed. Restarting Cycle ${cycle + 1} after ${Math.round(cycleDelayMs)}ms (backoff)`);
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
