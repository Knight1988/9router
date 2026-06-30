import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { needsInputEstimation } from "./usageTracking.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    onFirstContent = null,
    onProviderError = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE ? { ...initState(sourceFormat), provider, toolNameMap, model } : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let hasToolCalls = false;
  let hasEmittedContent = false;
  let firstContentFired = false;
  let lastFinishReason = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};
  // Diagnostic counters — always tracked (cheap integer ops), consumed only on empty-completion path
  const counters = { parseFailCount: 0, filterRejectCount: 0 };

  // Track last SSE event type to detect error events from upstream
  let lastSseEventType = null;
  let providerErrorFired = false; // fire once per stream — first error wins

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        // Always track SSE line counts for diagnostics (cheap integer ops)
        if (trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
            lastSseEventType = evt;
          } else if (trimmed.startsWith("data:")) {
            // Detect upstream error events: fire onProviderError before any content is committed
            if (lastSseEventType === "error" && onProviderError && !providerErrorFired) {
              const data = trimmed.slice(5).trim();
              if (data && data !== "[DONE]") {
                providerErrorFired = true;
                try {
                  onProviderError(JSON.parse(data));
                } catch {
                  onProviderError({ raw: data });
                }
              }
            }
            lastSseEventType = null; // reset after data line
          }
        }
        if (isDebugEnabled && trimmed) {
          // Additional per-line debug logging (dev only)
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              const hasValuable = hasValuableContent(parsed, FORMATS.OPENAI, counters);
              if (process.env.DEBUG === "1") {
                console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] 🔍 [DEBUG-passthrough] hasValuable=${hasValuable} chunk=${JSON.stringify(parsed).slice(0, 200)}`);
              }
              if (!hasValuable) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              const toolCallsInDelta = delta?.tool_calls?.length > 0;
              const hasRole = delta?.role;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }
              if (toolCallsInDelta) hasToolCalls = true;
              if ((content || reasoning || toolCallsInDelta) && onFirstContent && !firstContentFired) {
                if (process.env.DEBUG === "1") {
                  console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] 🔍 [DEBUG-passthrough] onFirstContent firing: content=${!!content} reasoning=${!!reasoning} toolCalls=${toolCallsInDelta}`);
                }
                firstContentFired = true;
                onFirstContent();
              }

              const extracted = extractUsage(parsed, body);
              if (extracted) {
                usage = extracted;
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk) lastFinishReason = parsed.choices[0].finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch { }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat, counters);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip here — flush() will emit [DONE]
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          const output = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed, body);
        if (extracted) { console.log("[USAGE-TRANSLATE] Extracted from chunk:", JSON.stringify(extracted)); state.usage = extracted; } // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        // Track tool calls from upstream (OpenAI or Claude format)
        if (parsed.choices?.[0]?.delta?.tool_calls?.length > 0) hasToolCalls = true;
        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") hasToolCalls = true;

        // Fire first-content signal as soon as we see any meaningful content or thinking
        if (onFirstContent && !firstContentFired && (accumulatedThinking || hasToolCalls)) {
          firstContentFired = true;
          onFirstContent();
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat, counters)) {
              continue; // Skip this empty chunk
            }

            // Fire onFirstContent only when actual text/thinking/tool content is present,
            // NOT on message_start (which is just a structural marker with no tokens)
            const hasActualContent = (() => {
              if (item.choices?.[0]?.delta?.content) return true;
              if (item.choices?.[0]?.delta?.reasoning_content) return true;
              if (item.choices?.[0]?.delta?.tool_calls?.length > 0) return true;
              if (item.type === "content_block_delta" && (item.delta?.text || item.delta?.thinking || item.delta?.partial_json)) return true;
              return false;
            })();
            if (hasActualContent && onFirstContent && !firstContentFired) {
              firstContentFired = true;
              onFirstContent();
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (isFinishChunk && state.finishReason) lastFinishReason = state.finishReason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            hasEmittedContent = true;
            sseEmittedCount++;
          }
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            if (process.env.DEBUG === "1") {
              console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] 🔍 [DEBUG-passthrough-flush] buffer=${JSON.stringify(buffer.slice(0, 300))} firstContentFired=${firstContentFired} totalContentLength=${totalContentLength}`);
            }

            // Detect non-streaming JSON response in passthrough mode.
            // Some providers (e.g. troll-llm) occasionally return a completed
            // chat.completion JSON body instead of SSE even when stream=true.
            // Convert it to a proper SSE chunk so detectContent sees real content.
            const trimmedBuffer = buffer.trim();
            if (!firstContentFired && trimmedBuffer.startsWith("{")) {
              try {
                const parsed = JSON.parse(trimmedBuffer);
                if (parsed.choices?.[0]?.message?.content) {
                  const content = parsed.choices[0].message.content;
                  const finishReason = parsed.choices[0].finish_reason || "stop";
                  const chunk = {
                    id: parsed.id || `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: parsed.created || Math.floor(Date.now() / 1000),
                    model: parsed.model || model,
                    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]
                  };
                  const finishChunk = {
                    id: chunk.id, object: "chat.completion.chunk", created: chunk.created, model: chunk.model,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                    usage: parsed.usage || null
                  };
                  totalContentLength += content.length;
                  accumulatedContent += content;
                  const chunkOutput = `data: ${JSON.stringify(chunk)}\n`;
                  const finishOutput = `data: ${JSON.stringify(finishChunk)}\n`;
                  reqLogger?.appendConvertedChunk?.(chunkOutput);
                  controller.enqueue(sharedEncoder.encode(chunkOutput));
                  reqLogger?.appendConvertedChunk?.(finishOutput);
                  controller.enqueue(sharedEncoder.encode(finishOutput));
                  firstContentFired = true;
                  onFirstContent?.();
                  // Skip normal buffer output below — we've already converted it
                  buffer = "";
                  if (process.env.DEBUG === "1") {
                    console.log(`[${new Date().toLocaleTimeString("en-US", { hour12: false })}] 🔍 [DEBUG-passthrough-flush] converted non-streaming JSON to SSE, content=${content.slice(0, 80)}`);
                  }
                }
              } catch {
                // Not valid JSON — fall through to normal buffer output
              }
            }

            if (buffer) {
              let output = buffer;
              if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
                output = "data: " + buffer.slice(5);
              }
              reqLogger?.appendConvertedChunk?.(output);
              controller.enqueue(sharedEncoder.encode(output));
            }
          }

          if (!hasValidUsage(usage) && totalContentLength > 0) {
            usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey);
          } else {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }
          
          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // However, Claude format clients expect the stream to end after message_stop
          // and do not expect [DONE].
          if (sourceFormat !== FORMATS.CLAUDE) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          if (onStreamComplete) {
            onStreamComplete({
              content: accumulatedContent,
              thinking: accumulatedThinking,
              emptyStream: totalContentLength === 0 && !accumulatedThinking,
              finishReason: lastFinishReason,
              _diagnostics: {
                sseLineCount,
                sseEmittedCount,
                eventTypeCounts,
                firstContentFired,
                hasEmittedContent,
                parseFailCount: counters.parseFailCount,
                filterRejectCount: counters.filterRejectCount,
              }
            }, usage, ttftAt);
          }
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim(), null, counters);
          if (parsed && !parsed.done) {
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (!keepsOpenAIResponsesFormat || !openAIResponsesDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
        }

        if (!hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        console.log("[USAGE-TRANSLATE] Before estimation check - state.usage:", state?.usage ? JSON.stringify(state.usage) : "null", "hasValidUsage:", hasValidUsage(state?.usage), "needsInputEstimation:", needsInputEstimation(state?.usage), "totalContentLength:", totalContentLength);
        if ((!hasValidUsage(state?.usage) || needsInputEstimation(state?.usage)) && totalContentLength > 0) {
          console.log("[USAGE-TRANSLATE] Estimating usage from body and contentLength"); state.usage = estimateUsage(body, totalContentLength, sourceFormat); console.log("[USAGE-TRANSLATE] Estimated usage:", JSON.stringify(state.usage));
        }

        console.log("[USAGE-TRANSLATE] Final usage before logUsage:", state?.usage ? JSON.stringify(state.usage) : "null");
        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        } else {
          console.log("[USAGE-TRANSLATE] No valid usage to log");
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        if (onStreamComplete) {
          const emptyStream = !hasEmittedContent && totalContentLength === 0 && !hasToolCalls && !accumulatedThinking;
          onStreamComplete({
            content: accumulatedContent,
            thinking: accumulatedThinking,
            emptyStream,
            finishReason: lastFinishReason || state?.finishReason || null,
            _diagnostics: {
              sseLineCount,
              sseEmittedCount,
              eventTypeCounts,
              firstContentFired,
              hasEmittedContent,
              parseFailCount: counters.parseFailCount,
              filterRejectCount: counters.filterRejectCount,
            }
          }, state?.usage, ttftAt);
        }
      } catch (error) {
        console.log("Error in flush:", error);
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, onFirstContent = null, onProviderError = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    onFirstContent,
    onProviderError
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, onFirstContent = null, sourceFormat = null, onProviderError = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    onFirstContent,
    sourceFormat,
    onProviderError
  });
}
