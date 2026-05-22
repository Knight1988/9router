import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

/**
 * Convert a Claude JSON response to SSE stream chunks.
 * Used for providers that don't support streaming but clients expect SSE.
 *
 * @param {Object} jsonResponse - Complete Claude JSON response
 * @returns {Array<string>} Array of SSE-formatted strings
 */
export function claudeJsonToSSE(jsonResponse) {
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
