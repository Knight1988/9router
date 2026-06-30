import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { createErrorResult } from "../../utils/error.js";
import { logAbnormal, ABNORMAL_SIGNALS, isAbnormalFinishReason } from "../../utils/abnormalLogger.js";
import { recordRequestResult } from "@/lib/smartRouting/healthTracker.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

const EMPTY_STREAM_TIMEOUT_MS = 60_000;
const NO_TIMEOUT_PROVIDERS = new Set(["techopenclaw"]);

// Max raw bytes to buffer for empty-completion diagnosis (64KB)
const RAW_CAPTURE_MAX = 64 * 1024;

/**
 * Create a fresh stream diagnostics context to thread through the pipeline.
 * Upstream tap writes counters + raw bytes; SSE transform writes _diagnostics via contentObj.
 */
function createStreamDiagnostics() {
  return {
    upstream: { chunkCount: 0, totalBytes: 0, firstChunkAt: null, lastChunkAt: null },
    rawCapture: { chunks: [], totalSize: 0, maxSize: RAW_CAPTURE_MAX, truncated: false },
  };
}

/**
 * Consume the raw capture buffer as a UTF-8 string (only call on the empty-completion path).
 * Clears the buffer after reading to free memory.
 */
function drainRawCapture(rawCapture) {
  if (rawCapture.chunks.length === 0) return "[no upstream data received]";
  try {
    const combined = Buffer.concat(rawCapture.chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)));
    const text = combined.toString("utf-8");
    return rawCapture.truncated ? text + `\n[TRUNCATED — buffer capped at ${RAW_CAPTURE_MAX} bytes]` : text;
  } catch {
    return "[raw capture decode error]";
  } finally {
    rawCapture.chunks = [];
    rawCapture.totalSize = 0;
  }
}

/**
 * Classify why an empty completion occurred based on pipeline diagnostic counters.
 * Returns a short tag used in the console warning and logAbnormal details.
 *
 * Modes:
 *  PROVIDER_EMPTY_BODY   — 0 raw bytes from upstream
 *  PROVIDER_NON_SSE      — bytes received but Content-Type isn't text/event-stream
 *  SSE_PARSE_FAILURE     — bytes received, but 0 SSE lines were successfully parsed
 *  SSE_MARKERS_ONLY      — SSE lines parsed, but no content/tool event ever fired
 *  CONTENT_FILTERED      — content chunks seen but all rejected by hasValuableContent
 *  TRANSLATION_EMPTY     — chunks survived filtering but translation emitted nothing
 *  UNKNOWN               — fallback
 */
function classifyEmptyCompletion(streamDiagnostics, diag, providerContentType) {
  const { upstream } = streamDiagnostics;

  if (upstream.totalBytes === 0) return "PROVIDER_EMPTY_BODY";

  const ct = (providerContentType || "").toLowerCase();
  if (!ct.includes("text/event-stream")) return "PROVIDER_NON_SSE";

  if ((diag?.sseLineCount ?? 0) === 0) return "SSE_PARSE_FAILURE";

  if (!diag?.firstContentFired) return "SSE_MARKERS_ONLY";

  if (diag?.firstContentFired && !diag?.hasEmittedContent) return "CONTENT_FILTERED";

  if (diag?.hasEmittedContent && (diag?.sseEmittedCount ?? 0) === 0) return "TRANSLATION_EMPTY";

  return "UNKNOWN";
}

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, onFirstContent }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, onFirstContent);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, onFirstContent);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, onFirstContent, sourceFormat);
}

/**
 * Consume the transformed stream to detect empty vs non-empty.
 *
 * Waits for:
 * - onFirstContent signal (meaningful content detected by transform) → "content"
 * - stream ends without onFirstContent → "empty" (end-of-stream)
 * - timeout fires → "empty" (timeout)
 *
 * Buffers all chunks so they can be replayed to the client.
 */
async function detectContent(transformedBody, timeoutMs, onFirstContentSignal) {
  const reader = transformedBody.getReader();
  const buffered = [];
  let settled = false;
  let contentDetected = false;
  let loopResolve;
  const loopDone = new Promise((res) => { loopResolve = res; });

  const result = await new Promise((resolve) => {
    const timer = timeoutMs != null ? setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ kind: "empty", reason: "timeout" });
      }
    }, timeoutMs) : null;

    onFirstContentSignal.callback = () => {
      contentDetected = true;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ kind: "content" });
      }
    };

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              // If we buffered chunks but onFirstContent never fired (race condition:
              // transform flush() completed before detectContent started), treat as content.
              // The transform already filtered via hasValuableContent, so buffered chunks ARE valuable.
              const hasBufferedContent = buffered.length > 0;
              const r = (contentDetected || hasBufferedContent) ? { kind: "content" } : { kind: "empty", reason: "end-of-stream" };
              resolve(r);
            }
            break;
          }
          // Buffer the current chunk first, then check if we should stop buffering.
          // This ensures we don't lose chunks that were enqueued before onFirstContent fired.
          buffered.push(value);
          // Stop buffering once content has been detected — buildReplayStream will
          // continue reading the remainder directly from this reader.
          if (settled) {
            break;
          }
        }
      } catch (err) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({ kind: "empty", reason: `read-error: ${err.message}` });
        }
      } finally {
        loopResolve();
      }
    })();
  });

  // Wait for the background loop to fully exit before returning the reader,
  // so buildReplayStream has exclusive access with no concurrent reads.
  await loopDone;

  return { result, reader, buffered };
}

/**
 * Build a replay + remainder stream from buffered chunks + an ongoing reader.
 */
function buildReplayStream(buffered, reader) {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of buffered) {
        controller.enqueue(chunk);
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); break; }
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    }
  });
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 * Guards against empty streams by waiting for first content before committing.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete }) {
  const onFirstContentSignal = { callback: null };
  const onFirstContent = () => {
    if (onFirstContentSignal.callback) onFirstContentSignal.callback();
  };

  // Create shared diagnostics context — threaded through the pipeline to the completion handler
  const streamDiagnostics = createStreamDiagnostics();
  const providerContentType = providerResponse.headers?.get?.("content-type") || null;
  const providerStatus = providerResponse.status ?? null;

  // Wrap onStreamComplete to inject pipeline diagnostics before the handler sees contentObj
  const wrappedOnStreamComplete = (contentObj, usage, ttftAt) => {
    if (contentObj) {
      contentObj._streamDiagnostics = streamDiagnostics;
      contentObj._streamMeta = { sourceFormat, targetFormat, providerStatus, providerContentType };
    }
    onStreamComplete(contentObj, usage, ttftAt);
  };

  const transformStream = buildTransformStream({
    provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body,
    onStreamComplete: wrappedOnStreamComplete, apiKey, onFirstContent
  });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs, streamDiagnostics);
  const timeoutMs = NO_TIMEOUT_PROVIDERS.has(provider) ? null : EMPTY_STREAM_TIMEOUT_MS;
  const { result: guardResult, reader, buffered } = await detectContent(transformedBody, timeoutMs, onFirstContentSignal);

  if (guardResult.kind === "empty") {
    const reason = guardResult.reason === "timeout" ? "timeout waiting for first content" : "stream ended with no content";
    try { reader.releaseLock(); } catch {}

    const rawBody = drainRawCapture(streamDiagnostics.rawCapture);
    logAbnormal({
      signal: ABNORMAL_SIGNALS.EMPTY_STREAM,
      provider,
      model,
      connectionId,
      endpoint: clientRawRequest?.endpoint || null,
      latencyMs: Date.now() - requestStartTime,
      details: {
        reason: guardResult.reason,
        upstream: { ...streamDiagnostics.upstream },
        streamConfig: { sourceFormat, targetFormat, providerStatus, providerContentType },
      },
      clientRequest: clientRawRequest,
      translatedRequest: translatedBody,
      targetRequest: finalBody ? { url: null, headers: null, body: finalBody } : null,
      providerResponseBody: rawBody,
    });
    recordRequestResult(`${provider}/${model}`, ABNORMAL_SIGNALS.EMPTY_STREAM, false);

    if (onRequestSuccess) {
      // Do NOT call onRequestSuccess — empty stream is a failure, keep account cooldown active
    }
    return createErrorResult(502, `Empty stream from ${provider}/${model}: ${reason}`);
  }

  // onRequestSuccess is deferred to onStreamComplete so empty completions can suppress it

  const clientStream = buildReplayStream(buffered, reader);

  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(clientStream, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, onRequestSuccess }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;
    const finishReason = contentObj?.finishReason || null;

    if (contentObj?.emptyStream) {
      console.warn(`[STREAM] WARNING: Empty stream from ${provider}/${model} (connection=${connectionId}). Possible format mismatch — provider may be returning a different format than expected.`);
    }

    // Detect empty completion: stream succeeded structurally but produced no tokens and no content.
    // This happens when upstream returns SSE markers (role, ping) but no actual text/tool output.
    // Suppress onRequestSuccess so the account cooldown is NOT cleared — combo cycling will skip it.
    const outTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    const hasContent = safeContent && safeContent !== "[Empty streaming response]" && safeContent.trim().length > 0;
    const hasToolCalls = contentObj?.toolCalls?.length > 0 || contentObj?.tool_calls?.length > 0;
    if (outTokens === 0 && !hasContent && !hasToolCalls) {
      const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? (promptTokens + outTokens);
      const thinkingLen = safeThinking ? safeThinking.length : 0;

      // Pull pipeline diagnostics injected by handleStreamingResponse's wrapper
      const streamDiagnostics = contentObj?._streamDiagnostics;
      const streamMeta = contentObj?._streamMeta;
      const diag = contentObj?._diagnostics;
      const upstream = streamDiagnostics?.upstream || {};
      const providerContentType = streamMeta?.providerContentType || null;
      const failureMode = classifyEmptyCompletion(streamDiagnostics || { upstream: {} }, diag, providerContentType);

      // Drain raw capture (clears buffer after reading)
      const rawBody = streamDiagnostics ? drainRawCapture(streamDiagnostics.rawCapture) : null;

      // Enhanced console warning — immediately actionable for live monitoring
      const evtSummary = diag?.eventTypeCounts
        ? Object.entries(diag.eventTypeCounts).map(([k, v]) => `${k}:${v}`).join(",") || "none"
        : "n/a";
      const emptyStreamFlag = contentObj?.emptyStream ? " emptyStreamFlag=true" : "";
      console.warn(
        `[EMPTY_COMPLETION] ${provider}/${model} conn=${connectionId} | ` +
        `mode=${failureMode} | ` +
        `upstream: ${upstream.chunkCount ?? "?"}chunks ${upstream.totalBytes ?? "?"}B ct=${providerContentType ?? "?"} | ` +
        `sse: ${diag?.sseLineCount ?? "?"}lines→${diag?.sseEmittedCount ?? "?"}emitted events={${evtSummary}} | ` +
        `filter: ${diag?.parseFailCount ?? "?"}parse-fail ${diag?.filterRejectCount ?? "?"}rejected | ` +
        `format: ${streamMeta?.sourceFormat ?? "?"}→${streamMeta?.targetFormat ?? "?"} | ` +
        `tokens: in=${promptTokens} out=${outTokens} total=${totalTokens} | ` +
        `thinkingLen=${thinkingLen} finish=${finishReason ?? "(none)"}${emptyStreamFlag} | ` +
        `Stream closed normally — client unaware of failure`
      );

      logAbnormal({
        signal: ABNORMAL_SIGNALS.EMPTY_COMPLETION,
        provider,
        model,
        connectionId,
        endpoint: clientRawRequest?.endpoint || null,
        latencyMs: latency.total,
        details: {
          failureMode,
          outTokens, hasContent: false, hasToolCalls: false, finishReason,
          promptTokens, totalTokens, thinkingLen,
          emptyStreamFlag: !!contentObj?.emptyStream,
          // Pipeline diagnostics
          upstream: {
            chunkCount: upstream.chunkCount ?? 0,
            totalBytes: upstream.totalBytes ?? 0,
            firstChunkAt: upstream.firstChunkAt ?? null,
            lastChunkAt: upstream.lastChunkAt ?? null,
          },
          sse: {
            lineCount: diag?.sseLineCount ?? null,
            emittedCount: diag?.sseEmittedCount ?? null,
            eventTypeCounts: diag?.eventTypeCounts ?? null,
            firstContentFired: diag?.firstContentFired ?? null,
            hasEmittedContent: diag?.hasEmittedContent ?? null,
            parseFailCount: diag?.parseFailCount ?? null,
            filterRejectCount: diag?.filterRejectCount ?? null,
          },
          streamConfig: {
            sourceFormat: streamMeta?.sourceFormat ?? null,
            targetFormat: streamMeta?.targetFormat ?? null,
            providerStatus: streamMeta?.providerStatus ?? null,
            providerContentType,
          },
          // What the client actually received
          clientSaw: {
            httpStatus: 200,
            format: "text/event-stream",
            streamClosedNormally: true,
            clientUnawareOfFailure: true,
            contentPreview: safeContent.slice(0, 200) || "(empty)"
          }
        },
        clientRequest: clientRawRequest,
        translatedRequest: translatedBody,
        targetRequest: finalBody ? { url: null, headers: null, body: finalBody } : null,
        providerResponseBody: rawBody,
        clientResponseBody: safeContent
      });
      recordRequestResult(`${provider}/${model}`, ABNORMAL_SIGNALS.EMPTY_COMPLETION, false);
      // Do NOT call onRequestSuccess — preserves account error state so combo cycling skips it next round
      return;
    }

    // Check for abnormal finish_reason
    if (finishReason && isAbnormalFinishReason(finishReason)) {
      logAbnormal({
        signal: ABNORMAL_SIGNALS.BAD_FINISH_REASON,
        provider,
        model,
        connectionId,
        endpoint: clientRawRequest?.endpoint || null,
        latencyMs: latency.total,
        details: { finishReason, outTokens, hasContent, hasToolCalls },
        clientRequest: clientRawRequest,
        translatedRequest: translatedBody,
        targetRequest: finalBody ? { url: null, headers: null, body: finalBody } : null,
        clientResponseBody: safeContent
      });
    }

    // Confirm success — clear account error state
    if (onRequestSuccess) onRequestSuccess();
    recordRequestResult(`${provider}/${model}`, "success", true);

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE" });
  };

  return { onStreamComplete, streamDetailId };
}
