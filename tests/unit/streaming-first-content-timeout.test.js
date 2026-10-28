import { afterEach, describe, expect, it, vi } from "vitest";
import { handleStreamingResponse } from "open-sse/handlers/chatCore/streamingHandler.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(),
}));
vi.mock("open-sse/utils/abnormalLogger.js", () => ({
  logAbnormal: vi.fn(),
  ABNORMAL_SIGNALS: { EMPTY_STREAM: "empty_stream" },
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
