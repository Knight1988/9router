/**
 * Unit tests: claudeJsonToSSE format conversion
 *
 * Verifies that claudeJsonToSSE correctly converts a Claude non-streaming JSON
 * response into SSE chunks, in both Claude and OpenAI formats.
 *
 * Bug context: techopenclaw provider forces non-streaming. When the client
 * requested streaming, the raw Claude JSON was converted back to SSE using
 * claudeJsonToSSE — but it always emitted Anthropic SSE format regardless of
 * the client's expected format (sourceFormat). This caused the `planning` model
 * to return raw Anthropic SSE to OpenAI clients.
 *
 * Fix: claudeJsonToSSE now accepts a sourceFormat parameter and emits the
 * correct SSE format for the client.
 */

import { describe, it, expect } from "vitest";
import { claudeJsonToSSE } from "open-sse/utils/jsonToSseConverter.js";
import { FORMATS } from "open-sse/translator/formats.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse all SSE data lines from a chunks array into objects. */
function parseChunks(chunks) {
  const events = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        events.push(JSON.parse(line.slice(6)));
      }
    }
  }
  return events;
}

/** Check whether chunks array ends with [DONE]. */
function hasDone(chunks) {
  return chunks.some((c) => c.includes("data: [DONE]"));
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CLAUDE_TEXT_RESPONSE = {
  id: "msg_abc123",
  model: "claude-opus-4.7",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "Hi there!" }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

const CLAUDE_TOOL_RESPONSE = {
  id: "msg_tool01",
  model: "claude-opus-4.7",
  stop_reason: "tool_use",
  content: [
    { type: "text", text: "Let me look that up." },
    {
      type: "tool_use",
      id: "toolu_xyz",
      name: "get_weather",
      input: { location: "Hanoi" },
    },
  ],
  usage: { input_tokens: 20, output_tokens: 15 },
};

const CLAUDE_THINKING_RESPONSE = {
  id: "msg_think1",
  model: "claude-opus-4.7",
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: "Let me reason..." },
    { type: "text", text: "The answer is 42." },
  ],
  usage: { input_tokens: 8, output_tokens: 12 },
};

const CLAUDE_EMPTY_CONTENT_RESPONSE = {
  id: "msg_empty1",
  model: "claude-opus-4.7",
  stop_reason: "end_turn",
  content: [],
  usage: { input_tokens: 5, output_tokens: 0 },
};

const CLAUDE_MAX_TOKENS_RESPONSE = {
  id: "msg_maxtok",
  model: "claude-opus-4.7",
  stop_reason: "max_tokens",
  content: [{ type: "text", text: "Truncated." }],
  usage: { input_tokens: 10, output_tokens: 2048 },
};

// ─── Tests: Claude format (default / backward-compat) ──────────────────────

describe("claudeJsonToSSE — Claude format (sourceFormat=claude)", () => {
  it("T1: returns Anthropic SSE event types", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.CLAUDE);
    const raw = chunks.join("");
    expect(raw).toContain("event: message_start");
    expect(raw).toContain("event: content_block_start");
    expect(raw).toContain("event: content_block_delta");
    expect(raw).toContain("event: content_block_stop");
    expect(raw).toContain("event: message_delta");
    expect(raw).toContain("event: message_stop");
  });

  it("T2: default sourceFormat is claude (backward compat)", () => {
    const chunksDefault = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE);
    const chunksExplicit = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.CLAUDE);
    expect(chunksDefault.join("")).toBe(chunksExplicit.join(""));
  });

  it("T3: text content appears in content_block_delta", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.CLAUDE);
    const raw = chunks.join("");
    expect(raw).toContain("Hi there!");
  });

  it("T4: thinking block emitted as thinking_delta", () => {
    const chunks = claudeJsonToSSE(CLAUDE_THINKING_RESPONSE, FORMATS.CLAUDE);
    const raw = chunks.join("");
    expect(raw).toContain("thinking_delta");
    expect(raw).toContain("Let me reason...");
    expect(raw).toContain("The answer is 42.");
  });

  it("T5: tool_use block emitted as input_json_delta", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TOOL_RESPONSE, FORMATS.CLAUDE);
    const raw = chunks.join("");
    expect(raw).toContain("input_json_delta");
    expect(raw).toContain("get_weather");
    expect(raw).toContain("Hanoi");
  });

  it("T6: message_start uses response id", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.CLAUDE);
    const raw = chunks.join("");
    const startLine = raw.split("\n").find((l) => l.includes("message_start"));
    expect(startLine).toBeDefined();
    const data = JSON.parse(raw.split("\n").find((l) => l.startsWith("data:") && l.includes("msg_abc123"))?.slice(6));
    expect(data.message.id).toBe("msg_abc123");
  });

  it("T7: empty content array produces message_start + message_delta + message_stop only", () => {
    const chunks = claudeJsonToSSE(CLAUDE_EMPTY_CONTENT_RESPONSE, FORMATS.CLAUDE);
    const raw = chunks.join("");
    expect(raw).toContain("event: message_start");
    expect(raw).toContain("event: message_delta");
    expect(raw).toContain("event: message_stop");
    expect(raw).not.toContain("content_block_start");
  });

  it("T8: stop_reason is preserved in message_delta", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.CLAUDE);
    const raw = chunks.join("");
    const deltaLine = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .find((d) => d?.type === "message_delta");
    expect(deltaLine?.delta?.stop_reason).toBe("end_turn");
  });
});

// ─── Tests: OpenAI format ────────────────────────────────────────────────────

describe("claudeJsonToSSE — OpenAI format (sourceFormat=openai)", () => {
  it("T9: returns OpenAI chat.completion.chunk objects", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.object).toBe("chat.completion.chunk");
    }
  });

  it("T10: no Anthropic SSE event lines (event: message_start etc)", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const raw = chunks.join("");
    expect(raw).not.toContain("event: message_start");
    expect(raw).not.toContain("event: content_block_delta");
    expect(raw).not.toContain("event: message_stop");
  });

  it("T11: ends with [DONE]", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    expect(hasDone(chunks)).toBe(true);
  });

  it("T12: first chunk has role=assistant delta", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const roleChunk = events.find((e) => e.choices?.[0]?.delta?.role === "assistant");
    expect(roleChunk).toBeDefined();
  });

  it("T13: text content appears in a delta.content chunk", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const textChunk = events.find((e) => e.choices?.[0]?.delta?.content === "Hi there!");
    expect(textChunk).toBeDefined();
  });

  it("T14: finish chunk has finish_reason=stop for end_turn", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const finishChunk = events.find((e) => e.choices?.[0]?.finish_reason === "stop");
    expect(finishChunk).toBeDefined();
  });

  it("T15: max_tokens maps to finish_reason=length", () => {
    const chunks = claudeJsonToSSE(CLAUDE_MAX_TOKENS_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const finishChunk = events.find((e) => e.choices?.[0]?.finish_reason === "length");
    expect(finishChunk).toBeDefined();
  });

  it("T16: tool_use maps to finish_reason=tool_calls", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TOOL_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const finishChunk = events.find((e) => e.choices?.[0]?.finish_reason === "tool_calls");
    expect(finishChunk).toBeDefined();
  });

  it("T17: tool_use block appears as tool_calls delta", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TOOL_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const toolChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk).toBeDefined();
    const toolCall = toolChunk.choices[0].delta.tool_calls[0];
    expect(toolCall.type).toBe("function");
    expect(toolCall.function.name).toBe("get_weather");
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ location: "Hanoi" });
  });

  it("T18: thinking block is silently dropped in OpenAI format", () => {
    const chunks = claudeJsonToSSE(CLAUDE_THINKING_RESPONSE, FORMATS.OPENAI);
    const raw = chunks.join("");
    expect(raw).not.toContain("thinking");
    const events = parseChunks(chunks);
    const textChunk = events.find((e) => e.choices?.[0]?.delta?.content === "The answer is 42.");
    expect(textChunk).toBeDefined();
  });

  it("T19: usage is present in the finish chunk", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const finishChunk = events.find((e) => e.choices?.[0]?.finish_reason === "stop");
    expect(finishChunk?.usage).toBeDefined();
    expect(finishChunk.usage.prompt_tokens).toBe(10);
    expect(finishChunk.usage.completion_tokens).toBe(5);
    expect(finishChunk.usage.total_tokens).toBe(15);
  });

  it("T20: id is prefixed with chatcmpl-", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    for (const e of events) {
      expect(e.id).toMatch(/^chatcmpl-/);
    }
  });

  it("T21: model field is preserved from response", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    for (const e of events) {
      expect(e.model).toBe("claude-opus-4.7");
    }
  });

  it("T22: empty content produces role chunk + finish chunk + [DONE], no text chunk", () => {
    const chunks = claudeJsonToSSE(CLAUDE_EMPTY_CONTENT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const textChunk = events.find(
      (e) => e.choices?.[0]?.delta?.content && e.choices[0].delta.content !== ""
    );
    expect(textChunk).toBeUndefined();
    const finishChunk = events.find((e) => e.choices?.[0]?.finish_reason === "stop");
    expect(finishChunk).toBeDefined();
    expect(hasDone(chunks)).toBe(true);
  });

  it("T23: all chunks share the same id", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TEXT_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(1);
  });

  it("T24: mixed text + tool_use emits both content and tool_calls chunks", () => {
    const chunks = claudeJsonToSSE(CLAUDE_TOOL_RESPONSE, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const textChunk = events.find((e) => e.choices?.[0]?.delta?.content);
    const toolChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(textChunk).toBeDefined();
    expect(toolChunk).toBeDefined();
  });

  it("T25: response with missing usage fields defaults to 0", () => {
    const response = { ...CLAUDE_TEXT_RESPONSE, usage: undefined };
    const chunks = claudeJsonToSSE(response, FORMATS.OPENAI);
    const events = parseChunks(chunks);
    const finishChunk = events.find((e) => e.choices?.[0]?.finish_reason);
    expect(finishChunk?.usage?.prompt_tokens).toBe(0);
    expect(finishChunk?.usage?.completion_tokens).toBe(0);
    expect(finishChunk?.usage?.total_tokens).toBe(0);
  });
});
