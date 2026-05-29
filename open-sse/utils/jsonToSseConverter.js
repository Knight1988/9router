import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

/**
 * Convert a Claude JSON response to SSE stream chunks.
 * Used for providers that don't support streaming but clients expect SSE.
 *
 * @param {Object} jsonResponse - Complete Claude JSON response
 * @param {string} [sourceFormat] - Client's expected format (FORMATS.OPENAI or FORMATS.CLAUDE).
 *   Defaults to FORMATS.CLAUDE for backward compatibility.
 * @returns {Array<string>} Array of SSE-formatted strings
 */
export function claudeJsonToSSE(jsonResponse, sourceFormat = FORMATS.CLAUDE) {
  // When the client expects OpenAI format, emit OpenAI chat.completion.chunk SSE
  if (sourceFormat === FORMATS.OPENAI) {
    return claudeJsonToOpenAISSE(jsonResponse);
  }

  const chunks = [];

  // 1. message_start
  chunks.push(formatSSE({
    type: "message_start",
    message: {
      id: jsonResponse.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: jsonResponse.model || "unknown",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  }, FORMATS.CLAUDE));

  // 2. content_block_start + content_block_delta + content_block_stop for each content block
  if (Array.isArray(jsonResponse.content)) {
    jsonResponse.content.forEach((block, index) => {
      if (block.type === "text") {
        // Text block
        chunks.push(formatSSE({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" }
        }, FORMATS.CLAUDE));

        chunks.push(formatSSE({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text || "" }
        }, FORMATS.CLAUDE));

        chunks.push(formatSSE({
          type: "content_block_stop",
          index
        }, FORMATS.CLAUDE));
      } else if (block.type === "thinking") {
        // Thinking block
        chunks.push(formatSSE({
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" }
        }, FORMATS.CLAUDE));

        chunks.push(formatSSE({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking || "" }
        }, FORMATS.CLAUDE));

        chunks.push(formatSSE({
          type: "content_block_stop",
          index
        }, FORMATS.CLAUDE));
      } else if (block.type === "tool_use") {
        // Tool use block
        chunks.push(formatSSE({
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id || `tool_${Date.now()}_${index}`,
            name: block.name || "",
            input: {}
          }
        }, FORMATS.CLAUDE));

        if (block.input) {
          chunks.push(formatSSE({
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          }, FORMATS.CLAUDE));
        }

        chunks.push(formatSSE({
          type: "content_block_stop",
          index
        }, FORMATS.CLAUDE));
      }
    });
  }

  // 3. message_delta with usage
  const usage = jsonResponse.usage || { input_tokens: 0, output_tokens: 0 };
  chunks.push(formatSSE({
    type: "message_delta",
    delta: { stop_reason: jsonResponse.stop_reason || "end_turn" },
    usage
  }, FORMATS.CLAUDE));

  // 4. message_stop
  chunks.push(formatSSE({
    type: "message_stop"
  }, FORMATS.CLAUDE));

  return chunks;
}

/**
 * Convert a Claude JSON response to OpenAI chat.completion.chunk SSE format.
 * @param {Object} jsonResponse - Complete Claude JSON response
 * @returns {Array<string>} Array of SSE-formatted strings
 */
function claudeJsonToOpenAISSE(jsonResponse) {
  const chunks = [];
  const id = jsonResponse.id ? `chatcmpl-${jsonResponse.id}` : `chatcmpl-${Date.now()}`;
  const model = jsonResponse.model || "unknown";
  const created = Math.floor(Date.now() / 1000);

  // Map Claude stop_reason → OpenAI finish_reason
  const stopReasonMap = { end_turn: "stop", max_tokens: "length", tool_use: "tool_calls" };
  const finishReason = stopReasonMap[jsonResponse.stop_reason] || jsonResponse.stop_reason || "stop";

  // 1. Role chunk
  chunks.push(formatSSE({
    id, object: "chat.completion.chunk", created, model,
    system_fingerprint: null,
    choices: [{ delta: { role: "assistant", content: "" }, index: 0, finish_reason: null, logprobs: null }]
  }));

  // 2. Content / tool_call chunks
  let textContent = "";
  const toolCalls = [];

  if (Array.isArray(jsonResponse.content)) {
    for (const block of jsonResponse.content) {
      if (block.type === "text") {
        textContent += block.text || "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          index: toolCalls.length,
          id: block.id || `call_${Date.now()}_${toolCalls.length}`,
          type: "function",
          function: {
            name: block.name || "",
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {})
          }
        });
      }
      // thinking blocks are silently dropped — OpenAI format has no equivalent
    }
  }

  if (textContent) {
    chunks.push(formatSSE({
      id, object: "chat.completion.chunk", created, model,
      system_fingerprint: null,
      choices: [{ delta: { content: textContent }, index: 0, finish_reason: null, logprobs: null }]
    }));
  }

  if (toolCalls.length > 0) {
    chunks.push(formatSSE({
      id, object: "chat.completion.chunk", created, model,
      system_fingerprint: null,
      choices: [{ delta: { tool_calls: toolCalls }, index: 0, finish_reason: null, logprobs: null }]
    }));
  }

  // 3. Finish chunk with usage
  const claudeUsage = jsonResponse.usage || {};
  const usage = {
    prompt_tokens: claudeUsage.input_tokens || 0,
    completion_tokens: claudeUsage.output_tokens || 0,
    total_tokens: (claudeUsage.input_tokens || 0) + (claudeUsage.output_tokens || 0)
  };

  chunks.push(formatSSE({
    id, object: "chat.completion.chunk", created, model,
    system_fingerprint: null,
    choices: [{ delta: {}, index: 0, finish_reason: finishReason, logprobs: null }],
    usage
  }));

  // 4. [DONE]
  chunks.push(formatSSE({ done: true }));

  return chunks;
}
