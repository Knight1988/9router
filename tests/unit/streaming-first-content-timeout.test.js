import { afterEach, describe, expect, it, vi } from "vitest";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "open-sse/utils/streamHandler.js";
import { handleComboChat } from "open-sse/services/combo.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));
vi.mock("open-sse/utils/abnormalLogger.js", () => ({
  logAbnormal: vi.fn(),
  ABNORMAL_SIGNALS: { EMPTY_STREAM: "empty_stream", PROVIDER_ERROR: "provider_error" },
  isAbnormalFinishReason: vi.fn(() => false),
}));
vi.mock("@/lib/smartRouting/healthTracker.js", () => ({ recordRequestResult: vi.fn() }));

const encoder = new TextEncoder();
const content = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n';

async function delayedContent(provider, delayMs) {
  vi.useFakeTimers();
  let upstream;
  const providerResponse = new Response(new ReadableStream({
    start(controller) { upstream = controller; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  // Keep the upstream active so this tests first content, not byte-stall detection.
  const heartbeat = setInterval(() => upstream.enqueue(encoder.encode(": ping\n\n")), 30_000);
  const pending = handleStreamingResponse({
    providerResponse,
    provider,
    model: "claude-opus-5-5",
    sourceFormat: "openai",
    targetFormat: "claude",
    body: { messages: [{ role: "user", content: "ping" }] },
    stream: true,
    requestStartTime: Date.now(),
    reqLogger: {
      appendProviderChunk: vi.fn(),
      appendConvertedChunk: vi.fn(),
      appendOpenAIChunk: vi.fn(),
    },
    streamController: {
      signal: new AbortController().signal,
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
    },
    onStreamComplete: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(delayMs);
  clearInterval(heartbeat);
  upstream.enqueue(encoder.encode(content));
  upstream.close();
  const result = await pending;
  return { result, text: await result.response.text() };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("streaming first-content timeout", () => {
  it("cancels a stalled upstream at the deadline so combo fallback can proceed", async () => {
    vi.useFakeTimers();
    let upstream;
    const cancel = vi.fn(() => new Promise(() => {}));
    const providerResponse = new Response(new ReadableStream({
      start(controller) { upstream = controller; },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const onRequestSuccess = vi.fn();
    const attempted = [];
    let firstResult;
    let completed = false;
    const pending = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["troll-llm/stalled", "openai/fallback"],
      comboName: "stalled-first-content-regression",
      comboStrategy: "fallback",
      log,
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        if (model === "openai/fallback") return new Response("fallback succeeded");
        firstResult = await handleStreamingResponse({
          providerResponse,
          provider: "troll-llm",
          model: "stalled",
          sourceFormat: "openai",
          targetFormat: "claude",
          body: { messages: [{ role: "user", content: "ping" }] },
          stream: true,
          requestStartTime: Date.now(),
          streamController: createStreamController({ log, provider: "troll-llm", model: "stalled" }),
          onStreamComplete: vi.fn(),
          onRequestSuccess,
        });
        return firstResult.response;
      },
    }).then(response => { completed = true; return response; });

    try {
      // Before the independent byte-stall watchdog, and without
      // closing the source or emitting another chunk to unblock reader.read().
      await vi.advanceTimersByTimeAsync(60_001);
      expect(completed).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(firstResult.success).toBe(false);
      expect(firstResult.response.status).toBe(502);
      expect(await firstResult.response.clone().text()).toContain("timeout waiting for first content");
      expect(attempted).toEqual(["troll-llm/stalled", "openai/fallback"]);
      expect(await (await pending).text()).toBe("fallback succeeded");
      expect(onRequestSuccess).not.toHaveBeenCalled();
    } finally {
      // Keep the RED case bounded: unblock the buggy pending read after assertions.
      if (!cancel.mock.calls.length) upstream.close();
      await pending;
    }
  });

  it("falls back promptly when a Claude error is followed by an open silent upstream", async () => {
    vi.useFakeTimers();
    let upstream;
    const cancel = vi.fn(() => new Promise(() => {}));
    const providerResponse = new Response(new ReadableStream({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Provider overloaded"}}\n\n'));
      },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const onRequestSuccess = vi.fn();
    const attempted = [];
    let firstResult;
    let completed = false;
    const pending = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["troll-llm/overloaded", "openai/fallback"],
      comboName: "open-provider-error-regression",
      comboStrategy: "fallback",
      log,
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        if (model === "openai/fallback") return new Response("fallback succeeded");
        firstResult = await handleStreamingResponse({
          providerResponse,
          provider: "troll-llm",
          model: "overloaded",
          sourceFormat: "openai",
          targetFormat: "claude",
          body: { messages: [{ role: "user", content: "ping" }] },
          stream: true,
          requestStartTime: Date.now(),
          streamController: createStreamController({ log, provider: "troll-llm", model: "overloaded" }),
          onStreamComplete: vi.fn(),
          onRequestSuccess,
        });
        return firstResult.response;
      },
    }).then(response => { completed = true; return response; });

    try {
      // Claude -> OpenAI translates this error into no output bytes. Neither
      // the first-content deadline nor the byte-stall watchdog should be needed.
      await vi.advanceTimersByTimeAsync(100);
      expect(completed).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(firstResult.success).toBe(false);
      expect(firstResult.response.status).toBe(429);
      expect(await firstResult.response.clone().text()).toContain("Provider overloaded");
      expect(attempted).toEqual(["troll-llm/overloaded", "openai/fallback"]);
      expect(await (await pending).text()).toBe("fallback succeeded");
      expect(onRequestSuccess).not.toHaveBeenCalled();
    } finally {
      // Bound the RED case without making source closure part of the assertion.
      if (!cancel.mock.calls.length) upstream.close();
      await pending;
    }
  });

  it("allows InfinityRouter content just before five minutes", async () => {
    const { result, text } = await delayedContent("infinityrouter", 299_999);
    expect(result.success).toBe(true);
    expect(text).toContain('"content":"ok"');
  });

  it("rejects InfinityRouter content after five minutes", async () => {
    const { result, text } = await delayedContent("infinityrouter", 300_001);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(text).toContain("timeout waiting for first content");
  });

  it("preserves the one-minute default for other providers", async () => {
    const { result, text } = await delayedContent("troll-llm", 60_001);
    expect(result.success).toBe(false);
    expect(text).toContain("timeout waiting for first content");
  });

  it("preserves TechOpenClaw's unlimited first-content wait", async () => {
    const { result } = await delayedContent("techopenclaw", 360_001);
    expect(result.success).toBe(true);
  });
});
