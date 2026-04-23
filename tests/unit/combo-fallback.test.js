/**
 * Unit tests: same-provider / different-model combo fallback
 *
 * Verifies that handleComboChat correctly advances through all combo entries
 * when the first model fails, with no same-provider short-circuit.
 *
 * Key invariant under test (combo.js:81):
 *   The loop is index-driven and provider-blind — only the model string matters.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";

// Minimal logger stub
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeResponse(status, body = {}) {
  const json = JSON.stringify(body);
  return new Response(json, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Two same-provider models (different names)
const MODEL_A = "anthropic/claude-opus-4-5";
const MODEL_B = "anthropic/claude-sonnet-4-5";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("combo fallback — same provider, different models", () => {
  it("T1: falls back to second model when first returns 500", async () => {
    const handleSingleModel = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(500, { error: { message: "upstream error" } }))
      .mockResolvedValueOnce(makeResponse(200, { choices: [{ message: { content: "ok" } }] }));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
    });

    // Both models tried in order
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls[0][1]).toBe(MODEL_A);
    expect(handleSingleModel.mock.calls[1][1]).toBe(MODEL_B);

    // Final response is the success from model B
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("ok");
  });

  it("T2: falls back on 400 — all statuses currently trigger shouldFallback:true", async () => {
    // errorConfig.js has no rule that returns shouldFallback:false.
    // The default at accountFallback.js:49 always returns shouldFallback:true.
    // This test documents the current behavior: even 400 falls through to the next entry.
    const handleSingleModel = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(400, { error: { message: "bad request" } }))
      .mockResolvedValueOnce(makeResponse(200, { choices: [{ message: { content: "fallback ok" } }] }));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
    });

    // Both called — 400 does NOT stop the combo
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("T3: returns last error when both models fail", async () => {
    const handleSingleModel = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(500, { error: { message: "model A down" } }))
      .mockResolvedValueOnce(makeResponse(500, { error: { message: "model B down" } }));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
    });

    // Both models attempted
    expect(handleSingleModel).toHaveBeenCalledTimes(2);

    // Response is an error (not ok)
    expect(result.ok).toBe(false);
    // combo.js:149: status is lastStatus (500) or 503
    expect([500, 503]).toContain(result.status);
  });

  it("T4: transient 503 waits cooldown then tries second model (fake timers)", async () => {
    vi.useFakeTimers();

    const handleSingleModel = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(503, { error: { message: "service unavailable" } }))
      .mockResolvedValueOnce(makeResponse(200, { choices: [{ message: { content: "recovered" } }] }));

    const promise = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
    });

    // Advance past the transient wait (combo.js:129, max 5000ms)
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("recovered");

    vi.useRealTimers();
  });

  it("T5: exception thrown by first model triggers fallback, second model succeeds", async () => {
    const handleSingleModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("network boom"))
      .mockResolvedValueOnce(makeResponse(200, { choices: [{ message: { content: "after throw" } }] }));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
    });

    // combo.js:136-141 catches throw and continues loop
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("after throw");
  });
});
