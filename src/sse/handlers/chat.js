import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS, HEARTBEAT_INTERVAL_MS } from "open-sse/config/runtimeConfig.js";
import { SSE_HEARTBEAT_COMMENT, SSE_HEADERS_CORS } from "open-sse/utils/sseConstants.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { compactBodyIfNeeded } from "open-sse/utils/contextCompactor.js";
import { getOpenClaudeResetsAtMs } from "open-sse/services/openClaudeQuota.js";
import { checkRateLimit } from "../utils/rateLimiter.js";
import { getEffectiveSmartPriority } from "@/lib/smartRouting/getEffectivePriority.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Rate limit per API key (30 req/min sliding window)
  if (apiKey) {
    const { allowed, retryAfter } = checkRateLimit(apiKey);
    if (!allowed) {
      log.warn("RATE_LIMIT", `API key ${log.maskKey(apiKey)} exceeded 30 req/min — retry in ${retryAfter}s`);
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded: 30 requests per minute", type: "rate_limit_error", code: "rate_limit_exceeded" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Retry-After": String(retryAfter) } }
      );
    }
  }

  // Auto-compact context if enabled and not an internal compaction call
  if (settings.autoCompactEnabled && !body._isInternalCompaction) {
    try {
      await compactBodyIfNeeded({ body, endpoint: request.url, settings, log });
    } catch (err) {
      log.warn("COMPACT", `Auto-compact failed, continuing with original context: ${err.message}`);
    }
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      // Fusion panels do non-streaming synthesis internally — no heartbeat needed.
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { skipHeartbeat: true });
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const smartPriority = getEffectiveSmartPriority(comboStrategies, modelStr, { intervalMinutes: settings.smartRoutingIntervalMinutes });
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    // For streaming combo requests, wrap handleComboChat in a heartbeat stream so
    // the client sees activity immediately while model cycling + detectContent() runs.
    // handleSingleModelChat uses skipHeartbeat:true so handleComboChat can still
    // observe real error statuses and cycle to the next model.
    const isStreaming = body.stream !== false;
    const comboResult = handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { skipHeartbeat: true }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      smartPriority,
      keepCycling: true,
      signal: request?.signal,
    });
    return isStreaming ? wrapComboWithHeartbeat(comboResult) : comboResult;
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Wrap a combo Response promise (from handleComboChat) in a heartbeat ReadableStream.
 * The heartbeat stream sends ": heartbeat\n\n" comments immediately and every
 * HEARTBEAT_INTERVAL_MS, keeping the client connection alive while model cycling
 * and detectContent() run. Once handleComboChat resolves, the real SSE body is
 * piped through. On failure, an SSE error event is sent before closing.
 *
 * @param {Promise<Response>} comboPromise
 * @returns {Response}
 */
function wrapComboWithHeartbeat(comboPromise) {
  const encoder = new TextEncoder();
  const heartbeatStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(SSE_HEARTBEAT_COMMENT));
      const timer = setInterval(() => {
        try { controller.enqueue(encoder.encode(SSE_HEARTBEAT_COMMENT)); } catch { clearInterval(timer); }
      }, HEARTBEAT_INTERVAL_MS);

      Promise.resolve(comboPromise)
        .then(async (finalResponse) => {
          clearInterval(timer);
          if (finalResponse.ok) {
            try {
              const reader = finalResponse.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } catch { /* client disconnected */ }
          } else {
            try {
              const errBody = await finalResponse.clone().json().catch(() => null);
              const errMsg = errBody?.error?.message || errBody?.error || finalResponse.statusText || "All models unavailable";
              const sseError = `data: ${JSON.stringify({ error: { message: errMsg, type: "service_unavailable" } })}\n\n`;
              controller.enqueue(encoder.encode(sseError));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch { /* ignore */ }
          }
          controller.close();
        })
        .catch(() => { clearInterval(timer); try { controller.close(); } catch { } });
    },
    cancel() { /* cleanup handled by catch branches above */ }
  });
  return new Response(heartbeatStream, { headers: SSE_HEADERS_CORS });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, { skipHeartbeat = false } = {}) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, the model string is not a provider/model pair.
  // Sub-combos are already expanded to leaves by getComboModels before handleComboChat
  // calls handleSingleModelChat, so reaching here with provider=null means the entry
  // is genuinely malformed (not a combo, not a valid alias).
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { skipHeartbeat: true });
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      const isStreaming2 = body.stream !== false;
      const comboResult2 = handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { skipHeartbeat: true }),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
      return isStreaming2 ? wrapComboWithHeartbeat(comboResult2) : comboResult2;
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Determine if this is a streaming request. Non-streaming responses return JSON
  // immediately, so no heartbeat is needed. Streaming requests may block for 60-120s
  // on detectContent() while a thinking model generates its first token — heartbeats
  // keep the connection alive during that wait.
  const isStreaming = body.stream !== false;

  if (!isStreaming || skipHeartbeat) {
    // Non-streaming path: unchanged — account fallback returns JSON synchronously.
    // skipHeartbeat=true is used by combo cycling so handleComboChat can observe
    // the real error status and cycle to the next model.
    return _runAccountFallback({ provider, model, body, userAgent, request, clientRawRequest, apiKey });
  }

  // Streaming path: wrap the account fallback loop in a ReadableStream that emits
  // SSE heartbeat comments (": heartbeat\n\n") every HEARTBEAT_INTERVAL_MS while
  // waiting for detectContent() to resolve. When content is found, the heartbeat
  // stream is replaced by the real SSE content. When all accounts are exhausted,
  // an SSE error event is sent before closing.
  const encoder = new TextEncoder();
  const heartbeatStream = new ReadableStream({
    start(controller) {
      // Send the first heartbeat immediately so the client sees bytes right away.
      controller.enqueue(encoder.encode(SSE_HEARTBEAT_COMMENT));
      const timer = setInterval(() => {
        try { controller.enqueue(encoder.encode(SSE_HEARTBEAT_COMMENT)); } catch { clearInterval(timer); }
      }, HEARTBEAT_INTERVAL_MS);

      // Run the account fallback loop in the background. We don't await this so
      // the Response can be returned immediately with the heartbeat stream.
      _runAccountFallback({ provider, model, body, userAgent, request, clientRawRequest, apiKey })
        .then(async (finalResponse) => {
          clearInterval(timer);
          if (finalResponse.ok) {
            // Pipe successful SSE response body into the heartbeat stream.
            try {
              const reader = finalResponse.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } catch { /* client disconnected */ }
          } else {
            // All accounts exhausted — surface error as SSE event so clients can surface it.
            try {
              const errBody = await finalResponse.clone().json().catch(() => null);
              const errMsg = errBody?.error?.message || errBody?.error || finalResponse.statusText || "All accounts unavailable";
              const sseError = `data: ${JSON.stringify({ error: { message: errMsg, type: "service_unavailable" } })}\n\n`;
              controller.enqueue(encoder.encode(sseError));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch { /* ignore encoding errors */ }
          }
          controller.close();
        })
        .catch(() => { clearInterval(timer); try { controller.close(); } catch { } });
    },
    cancel() {
      // Client disconnected — cleanup is handled by the catch branches above.
    }
  });

  return new Response(heartbeatStream, { headers: SSE_HEADERS_CORS });
}

/**
 * Core account fallback loop — tries provider accounts in sequence, returning the
 * first successful Response or the last error Response when all accounts are exhausted.
 * Used by both the streaming heartbeat wrapper and the non-streaming path.
 */
async function _runAccountFallback({ provider, model, body, userAgent, request, clientRawRequest, apiKey }) {
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    // open-claude returns 402 on quota exhaustion; the body has no reset time but the
    // usage API exposes period_reset_at. Plumb it as resetsAtMs so the cooldown matches
    // the actual 2h quota window (capped at MAX_RATE_LIMIT_COOLDOWN_MS = 30 min) instead
    // of the generic 2-minute fallback.
    if (!result.resetsAtMs && provider === "open-claude" && result.status === 402) {
      const resetsAtMs = await getOpenClaudeResetsAtMs(credentials._connection || credentials);
      if (resetsAtMs) result.resetsAtMs = resetsAtMs;
    }

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
