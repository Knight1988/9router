/**
 * Health Tracker for Smart Routing
 * Tracks provider health metrics (empty_completion rate, abnormal signals) to adjust priority.
 *
 * Integrates with abnormalLogger to record failures and compute health scores.
 */

import fs from "fs";
import path from "path";

// Time window for health tracking (default: 1 hour)
const HEALTH_WINDOW_MS = 60 * 60 * 1000;

// Thresholds for health scoring
const EMPTY_COMPLETION_THRESHOLD = 0.5; // 50% empty_completion rate = unhealthy
const MIN_REQUESTS_FOR_SCORING = 3; // Need at least 3 requests to compute health

// In-memory health data per provider/model
// Structure: Map<modelStr, { requests: [], lastCleanup: timestamp }>
// requests: [{ timestamp, signal, success }]
const healthData = new Map();

/**
 * Parse a model string to extract provider ID
 */
function modelStringToProviderId(modelStr) {
  if (!modelStr || !modelStr.includes("/")) return null;
  const [provider] = modelStr.split("/");
  return provider;
}

/**
 * Record a request result for health tracking
 * @param {string} modelStr - Model string (e.g., "techopenclaw/claude-opus-4.7")
 * @param {string} signal - ABNORMAL_SIGNALS value or "success"
 * @param {boolean} success - Whether the request succeeded (produced usable output)
 */
export function recordRequestResult(modelStr, signal, success) {
  if (!modelStr) return;

  const now = Date.now();
  let data = healthData.get(modelStr);

  if (!data) {
    data = { requests: [], lastCleanup: now };
    healthData.set(modelStr, data);
  }

  // Add new request
  data.requests.push({ timestamp: now, signal, success });

  // Cleanup old requests (outside time window) every 5 minutes
  if (now - data.lastCleanup > 5 * 60 * 1000) {
    const cutoff = now - HEALTH_WINDOW_MS;
    data.requests = data.requests.filter(r => r.timestamp > cutoff);
    data.lastCleanup = now;
  }
}

/**
 * Compute health score for a model (0.0 = unhealthy, 1.0 = healthy)
 * @param {string} modelStr
 * @returns {{ score: number, stats: object }}
 */
export function getHealthScore(modelStr) {
  const data = healthData.get(modelStr);

  if (!data || data.requests.length < MIN_REQUESTS_FOR_SCORING) {
    // Not enough data - assume healthy (neutral score)
    return {
      score: 1.0,
      stats: {
        totalRequests: data?.requests.length || 0,
        insufficientData: true
      }
    };
  }

  // Filter to time window
  const now = Date.now();
  const cutoff = now - HEALTH_WINDOW_MS;
  const recentRequests = data.requests.filter(r => r.timestamp > cutoff);

  if (recentRequests.length < MIN_REQUESTS_FOR_SCORING) {
    return {
      score: 1.0,
      stats: {
        totalRequests: recentRequests.length,
        insufficientData: true
      }
    };
  }

  // Compute metrics
  const totalRequests = recentRequests.length;
  const successfulRequests = recentRequests.filter(r => r.success).length;
  const emptyCompletions = recentRequests.filter(r => r.signal === "empty_completion").length;
  const providerErrors = recentRequests.filter(r => r.signal === "provider_error").length;
  const formatMismatches = recentRequests.filter(r => r.signal === "format_mismatch").length;

  const successRate = successfulRequests / totalRequests;
  const emptyCompletionRate = emptyCompletions / totalRequests;
  const errorRate = (providerErrors + formatMismatches) / totalRequests;

  // Health score formula:
  // - Start with success rate (0.0 - 1.0)
  // - Heavily penalize empty_completion rate (subtract 2x the rate)
  // - Penalize error rate (subtract 1x the rate)
  let score = successRate - (2.0 * emptyCompletionRate) - (1.0 * errorRate);

  // Clamp to [0.0, 1.0]
  score = Math.max(0.0, Math.min(1.0, score));

  return {
    score,
    stats: {
      totalRequests,
      successfulRequests,
      emptyCompletions,
      providerErrors,
      formatMismatches,
      successRate: successRate.toFixed(3),
      emptyCompletionRate: emptyCompletionRate.toFixed(3),
      errorRate: errorRate.toFixed(3),
      windowMs: HEALTH_WINDOW_MS
    }
  };
}

/**
 * Get health scores for all tracked models
 * @returns {Map<string, { score: number, stats: object }>}
 */
export function getAllHealthScores() {
  const scores = new Map();
  for (const [modelStr] of healthData) {
    scores.set(modelStr, getHealthScore(modelStr));
  }
  return scores;
}

/**
 * Clear health data for a specific model or all models
 * @param {string} [modelStr] - Model to clear, or undefined to clear all
 */
export function clearHealthData(modelStr) {
  if (modelStr) {
    healthData.delete(modelStr);
  } else {
    healthData.clear();
  }
}

/**
 * Get raw health data for debugging
 * @returns {Map<string, object>}
 */
export function getHealthData() {
  return healthData;
}

/**
 * Adjust priority based on health scores
 * Models with health score < 0.5 are demoted to the end of the list
 * @param {Array<{ model: string, percent: number|null, ok: boolean }>} results - Quota check results
 * @returns {Array<{ model: string, percent: number|null, ok: boolean, healthScore: number }>}
 */
export function applyHealthScoring(results) {
  const scored = results.map(r => {
    const health = getHealthScore(r.model);
    return { ...r, healthScore: health.score, healthStats: health.stats };
  });

  // Sort by: health score (desc), then quota percent (desc)
  // Unhealthy models (score < 0.5) go to the end
  scored.sort((a, b) => {
    const aHealthy = a.healthScore >= 0.5;
    const bHealthy = b.healthScore >= 0.5;

    // Healthy models come before unhealthy
    if (aHealthy !== bHealthy) {
      return bHealthy ? 1 : -1;
    }

    // Within same health tier, sort by health score first
    if (Math.abs(a.healthScore - b.healthScore) > 0.1) {
      return b.healthScore - a.healthScore;
    }

    // Then by quota percent
    const pa = a.percent ?? -1;
    const pb = b.percent ?? -1;
    return pb - pa;
  });

  return scored;
}
