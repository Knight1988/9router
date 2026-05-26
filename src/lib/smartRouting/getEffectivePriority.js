import { triggerSmartRoutingRefresh } from "./scheduler.js";

const DEFAULT_INTERVAL_MINUTES = 15;
const STALE_MULTIPLIER = 3;

/**
 * Returns the cached smartPriority for a combo if it's still fresh, otherwise
 * returns undefined (causing applySmartPriority to fall back to original order)
 * and fires an async background refresh.
 *
 * @param {Record<string, object>} comboStrategies - settings.comboStrategies
 * @param {string} comboName
 * @param {{ intervalMinutes?: number }} options
 * @returns {string[] | undefined}
 */
export function getEffectiveSmartPriority(comboStrategies, comboName, { intervalMinutes } = {}) {
  const data = comboStrategies?.[comboName];
  const priority = data?.smartPriority;
  if (!priority || priority.length === 0) return undefined;

  const updatedAt = data?.smartPriorityUpdatedAt;
  if (!updatedAt) return undefined;

  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const interval = Number.isFinite(Number(intervalMinutes)) && Number(intervalMinutes) > 0
    ? Number(intervalMinutes)
    : DEFAULT_INTERVAL_MINUTES;
  const thresholdMs = STALE_MULTIPLIER * interval * 60_000;

  if (!Number.isFinite(ageMs) || ageMs > thresholdMs) {
    console.warn(
      `[SmartRouting] stale priority for "${comboName}" (age: ${Math.round(ageMs / 60_000)}m > threshold: ${STALE_MULTIPLIER * interval}m), falling back to original order`
    );
    // Fire-and-forget; scheduler's g.running guard prevents concurrent runs
    triggerSmartRoutingRefresh(comboName).catch((err) => {
      console.warn(`[SmartRouting] background refresh failed for "${comboName}": ${err.message}`);
    });
    return undefined;
  }

  return priority;
}
