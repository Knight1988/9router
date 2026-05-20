/**
 * Smart Routing Scheduler
 * Periodically refreshes combo model priority based on provider quota.
 * Singleton via globalThis to survive Next.js HMR.
 */

import { getSettings, updateSettings, getCombos } from "@/lib/localDb";
import { computeSmartPriority } from "./quotaCheck.js";

const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

// Singleton state
const g = globalThis.__smartRoutingScheduler ??= {
  timer: null,
  running: false,
  lastRunAt: null,
};

function clampInterval(minutes) {
  const n = Number.parseInt(minutes, 10);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, n));
}

/**
 * Run a single refresh cycle: for every combo with smart-routing enabled,
 * compute new priority and persist it into comboStrategies.
 * @param {string|null} [onlyComboName] - If set, only refresh this combo.
 */
export async function runSmartRoutingRefresh(onlyComboName = null) {
  if (g.running) return;
  g.running = true;
  try {
    const [settings, combos] = await Promise.all([getSettings(), getCombos()]);
    const comboStrategies = settings.comboStrategies || {};

    const targets = combos.filter((c) => {
      if (c.kind) return false; // skip media combos
      const strategy = comboStrategies[c.name]?.fallbackStrategy;
      if (strategy !== "smart-routing") return false;
      if (onlyComboName && c.name !== onlyComboName) return false;
      return true;
    });

    if (targets.length === 0) return;

    const updatedStrategies = { ...comboStrategies };

    await Promise.all(targets.map(async (combo) => {
      try {
        const result = await computeSmartPriority(combo);
        updatedStrategies[combo.name] = {
          ...updatedStrategies[combo.name],
          fallbackStrategy: "smart-routing",
          smartPriority: result.priority,
          smartPriorityUpdatedAt: new Date().toISOString(),
          smartPriorityError: result.errors.length > 0
            ? result.errors.map((e) => `${e.model}: ${e.reason}`).join("; ")
            : null,
        };
        console.log(`[SmartRouting] ${combo.name}: priority updated → [${result.priority.join(", ")}]`);
      } catch (err) {
        console.warn(`[SmartRouting] ${combo.name}: refresh failed — ${err.message}`);
        updatedStrategies[combo.name] = {
          ...updatedStrategies[combo.name],
          fallbackStrategy: "smart-routing",
          smartPriorityError: err.message,
          smartPriorityUpdatedAt: new Date().toISOString(),
        };
      }
    }));

    await updateSettings({ comboStrategies: updatedStrategies });
    g.lastRunAt = new Date();
  } finally {
    g.running = false;
  }
}

/**
 * Trigger a refresh immediately (optionally for a single combo).
 * Returns a promise that resolves when the refresh is done.
 */
export async function triggerSmartRoutingRefresh(comboName = null) {
  return runSmartRoutingRefresh(comboName);
}

/**
 * Start (or restart) the scheduler with the current interval from settings.
 * Safe to call multiple times — clears any existing timer first.
 */
export async function startSmartRoutingScheduler() {
  stopSmartRoutingScheduler();

  let intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  try {
    const settings = await getSettings();
    intervalMinutes = clampInterval(settings.smartRoutingIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
  } catch {
    // use default
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`[SmartRouting] Scheduler started (interval: ${intervalMinutes}m)`);

  g.timer = setInterval(async () => {
    try {
      await runSmartRoutingRefresh();
    } catch (err) {
      console.warn("[SmartRouting] Scheduler tick error:", err.message);
    }
  }, intervalMs);

  // Don't block startup — run first refresh after a short delay
  setTimeout(async () => {
    try {
      await runSmartRoutingRefresh();
    } catch (err) {
      console.warn("[SmartRouting] Initial refresh error:", err.message);
    }
  }, 5000);
}

/**
 * Stop the scheduler.
 */
export function stopSmartRoutingScheduler() {
  if (g.timer) {
    clearInterval(g.timer);
    g.timer = null;
    console.log("[SmartRouting] Scheduler stopped");
  }
}

/**
 * Get scheduler status (for debugging / API).
 */
export function getSmartRoutingSchedulerStatus() {
  return {
    active: g.timer !== null,
    running: g.running,
    lastRunAt: g.lastRunAt?.toISOString() ?? null,
  };
}
