import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { createErrorResult } from "../../utils/error.js";
import { logAbnormal, ABNORMAL_SIGNALS, isAbnormalFinishReason } from "../../utils/abnormalLogger.js";
import { recordRequestResult } from "@/lib/smartRouting/healthTracker.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*"
};

const EMPTY_STREAM_TIMEOUT_MS = 30_000;

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, onFirstContent }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  const needsCodexTranslation = provider === "codex" && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    let codexTarget;
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) codexTarget = FORMATS.OPENAI_RESPONSES;
    else if (sourceFormat === FORMATS.CLAUDE) codexTarget = FORMATS.CLAUDE;
    else if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) codexTarget = FORMATS.ANTIGRAVITY;
    else codexTarget = FORMATS.OPENAI;
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
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ kind: "empty", reason: "timeout" });
      }
    }, timeoutMs);

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

  const transformStream = buildTransformStream({
    provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body,
    onStreamComplete, apiKey, onFirstContent
  });

  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController);

  const { result: guardResult, reader, buffered } = await detectContent(transformedBody, EMPTY_STREAM_TIMEOUT_MS, onFirstContentSignal);

  if (guardResult.kind === "empty") {
    const reason = guardResult.reason === "timeout" ? "timeout waiting for first content" : "stream ended with no content";
    try { reader.releaseLock(); } catch {}
    
    logAbnormal({
      signal: ABNORMAL_SIGNALS.EMPTY_STREAM,
      provider,
      model,
      connectionId,
      endpoint: clientRawRequest?.endpoint || null,
      latencyMs: Date.now() - requestStartTime,
      details: { reason: guardResult.reason },
      clientRequest: clientRawRequest,
      translatedRequest: translatedBody,
      targetRequest: finalBody ? { url: null, headers: null, body: finalBody } : null
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
      logAbnormal({
        signal: ABNORMAL_SIGNALS.EMPTY_COMPLETION,
        provider,
        model,
        connectionId,
        endpoint: clientRawRequest?.endpoint || null,
        latencyMs: latency.total,
        details: { outTokens, hasContent: false, hasToolCalls: false, finishReason },
        clientRequest: clientRawRequest,
        translatedRequest: translatedBody,
        targetRequest: finalBody ? { url: null, headers: null, body: finalBody } : null,
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
