import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleComboChat,
  getStickyComboModel,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const models = ["openai/model-a", "openai/model-b"];
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const failed = () => json({ error: { message: "temporary failure" } }, 500);
const sse = (content = "", finish = "stop") => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
    ...(content ? [`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`] : []),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
};
const options = { body: { messages: [{ role: "user", content: "hi" }] }, models, log };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetComboRotation();
});

describe("combo merge regression — retry cycles and smart/empty fallback coexist", () => {
  it("retains beta smart-priority ordering on every retry cycle", async () => {
    vi.useFakeTimers();
    const handleSingleModel = vi.fn()
      .mockImplementationOnce(failed)
      .mockImplementationOnce(failed)
      .mockImplementationOnce(() => sse("recovered"));
    const pending = handleComboChat({
      ...options, handleSingleModel, comboStrategy: "smart-routing",
      smartPriority: [models[1], "removed/model"], keepCycling: true,
    });
    await vi.runAllTimersAsync();
    expect(await (await pending).text()).toContain("recovered");
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([models[1], models[0], models[1]]);
  });

  it("retries the smart-selected order, then skips its empty SSE and clears stickiness", async () => {
    vi.useFakeTimers();
    const resolveSmartChoice = vi.fn(async () => ({ choice: models[1], confidence: 0.95 }));
    const handleSingleModel = vi.fn()
      .mockImplementationOnce(failed)
      .mockImplementationOnce(failed)
      .mockImplementationOnce(() => sse())
      .mockImplementationOnce(() => sse("fallback content"));
    const pending = handleComboChat({
      ...options, handleSingleModel, comboStrategy: "smart", comboName: "merge-smart",
      sessionId: "merge-session", resolveSmartChoice, keepCycling: true,
    });
    await vi.runAllTimersAsync();
    expect(await (await pending).text()).toContain("fallback content");
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual([models[1], models[0], models[1], models[0]]);
    expect(resolveSmartChoice).toHaveBeenCalledTimes(1);
    expect(getStickyComboModel("merge-smart", "merge-session", models)).toBeNull();
  });

  it.each(["stop", "content_filter"])("returns the last empty SSE (%s) without restarting cycles", async (finish) => {
    const handleSingleModel = vi.fn()
      .mockImplementationOnce(failed)
      .mockImplementationOnce(() => sse("", finish));
    const result = await handleComboChat({ ...options, handleSingleModel, keepCycling: true });
    expect(result.status).toBe(200);
    expect(await result.text()).toContain(`[DONE]`);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("retains the earliest retryAfter when all members fail", async () => {
    vi.useFakeTimers();
    const later = new Date(Date.now() + 120_000).toISOString();
    const earlier = new Date(Date.now() + 60_000).toISOString();
    const handleSingleModel = vi.fn()
      .mockImplementationOnce(() => json({ error: { message: "rate limited" }, retryAfter: later }, 429))
      .mockImplementationOnce(() => json({ error: { message: "rate limited" }, retryAfter: earlier }, 429));
    const result = await handleComboChat({ ...options, handleSingleModel });
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("60");
    expect((await result.json()).error.message).toContain("rate limited");
  });

  it("stops after an exception when the client aborts mid-cycle", async () => {
    const controller = new AbortController();
    const handleSingleModel = vi.fn(async () => {
      controller.abort();
      throw new Error("connection closed");
    });
    const result = await handleComboChat({ ...options, handleSingleModel, keepCycling: true, signal: controller.signal });
    expect(result.status).toBe(500);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });
});
