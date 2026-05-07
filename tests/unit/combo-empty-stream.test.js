/**
 * Unit tests: empty streaming response detection
 *
 * Verifies that handleStreamingResponse detects empty streams (no content,
 * no thinking, no tool calls) and returns a failure result instead of
 * committing to a streaming response.
 *
 * Key behavior under test:
 * - Empty stream → { success: false, status: 502 }
 * - Thinking-only stream → { success: true } (not empty)
 * - Tool-call-only stream → { success: true } (not empty)
 * - Timeout waiting for first content → { success: false }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper: create a streaming Response that emits SSE chunks
 */
function makeStreamingResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

const mockStreamController = {
  signal: new AbortController().signal,
  isConnected: () => true,
  handleComplete: vi.fn(),
  handleError: vi.fn()
};

const baseContext = {
  provider: "troll-llm",
  model: "claude-opus-4-6",
  sourceFormat: "openai",
  targetFormat: "claude",
  userAgent: "test-client",
  body: { messages: [{ role: "user", content: "ping" }] },
  stream: true,
  translatedBody: { messages: [{ role: "user", content: "ping" }] },
  finalBody: null,
  requestStartTime: Date.now(),
  connectionId: "test-conn-123",
  apiKey: "sk_test",
  clientRawRequest: null,
  onRequestSuccess: vi.fn(),
  reqLogger: {
    appendProviderChunk: vi.fn(),
    appendConvertedChunk: vi.fn(),
    appendOpenAIChunk: vi.fn()
  },
  toolNameMap: null,
  streamController: mockStreamController,
  onStreamComplete: vi.fn()
};

describe("handleStreamingResponse — empty stream detection", () => {
  it("T1: empty stream (immediate [DONE]) → failure result", async () => {
    const providerResponse = makeStreamingResponse(["data: [DONE]\n\n"]);

    const result = await handleStreamingResponse({
      ...baseContext,
      providerResponse
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Empty stream");
  }, 35000);

  it("T2: stream with content → success", async () => {
    const providerResponse = makeStreamingResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      "data: [DONE]\n\n"
    ]);

    const result = await handleStreamingResponse({
      ...baseContext,
      providerResponse
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeInstanceOf(Response);
  }, 10000);

  it("T3: thinking-only stream → success (not empty)", async () => {
    const providerResponse = makeStreamingResponse([
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      "data: [DONE]\n\n"
    ]);

    const result = await handleStreamingResponse({
      ...baseContext,
      providerResponse
    });

    expect(result.success).toBe(true);
  }, 10000);

  it("T4: tool-call-only stream (OpenAI format) → success (not empty)", async () => {
    const providerResponse = makeStreamingResponse([
      'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n"
    ]);

    const result = await handleStreamingResponse({
      ...baseContext,
      sourceFormat: "openai",
      targetFormat: "openai",
      providerResponse
    });

    expect(result.success).toBe(true);
  }, 10000);

  it("T5: stream with only whitespace → failure", async () => {
    const providerResponse = makeStreamingResponse([
      "data: \n\n",
      "data: [DONE]\n\n"
    ]);

    const result = await handleStreamingResponse({
      ...baseContext,
      providerResponse
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  }, 35000);
});
