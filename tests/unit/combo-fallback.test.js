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

describe("combo cycling — keepCycling + signal", () => {
  it("T6: cycles restart from first model, abort stops cleanly", async () => {
    const controller = new AbortController();
    let callCount = 0;

    const handleSingleModel = vi.fn().mockImplementation(async () => {
      callCount++;
      // Fail first 3 calls (full cycle 1 + model A in cycle 2), then abort
      if (callCount === 3) {
        controller.abort();
      }
      return makeResponse(500, { error: { message: "fail" } });
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
      keepCycling: true,
      signal: controller.signal,
    });

    // Cycle 1: A fails, B fails → restart
    // Cycle 2: A fails (abort fires) → exit
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
    expect(handleSingleModel.mock.calls[0][1]).toBe(MODEL_A); // Cycle 1
    expect(handleSingleModel.mock.calls[1][1]).toBe(MODEL_B); // Cycle 1
    expect(handleSingleModel.mock.calls[2][1]).toBe(MODEL_A); // Cycle 2

    // Returns 503 after abort
    expect(result.ok).toBe(false);
    expect([500, 503]).toContain(result.status);
  });

  it("T7: success on retry cycle returns immediately", async () => {
    vi.useFakeTimers();
    let callCount = 0;

    const handleSingleModel = vi.fn().mockImplementation(async (body, modelStr) => {
      callCount++;
      // Model A: fail twice, succeed third time
      // Model B: always fail
      if (modelStr === MODEL_A && callCount === 5) {
        return makeResponse(200, { choices: [{ message: { content: "success on retry" } }] });
      }
      return makeResponse(500, { error: { message: "fail" } });
    });

    const promise = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
      keepCycling: true,
      signal: new AbortController().signal,
    });

    // Advance through cycle delays
    await vi.runAllTimersAsync();

    const result = await promise;

    // Cycle 1: A fails, B fails → wait 1500ms
    // Cycle 2: A fails, B fails → wait 1500ms
    // Cycle 3: A succeeds
    expect(handleSingleModel).toHaveBeenCalledTimes(5);
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("success on retry");

    vi.useRealTimers();
  });

  it("T8: cycle delay is abortable — exits promptly on abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let callCount = 0;

    const handleSingleModel = vi.fn().mockImplementation(async () => {
      callCount++;
      // After first full cycle (2 calls), abort during the delay
      if (callCount === 2) {
        // Schedule abort to fire during the 1500ms delay
        setTimeout(() => controller.abort(), 500);
      }
      return makeResponse(500, { error: { message: "fail" } });
    });

    const promise = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
      keepCycling: true,
      signal: controller.signal,
    });

    // Advance timers: cycle 1 completes, delay starts, abort fires at 500ms
    await vi.runAllTimersAsync();

    const result = await promise;

    // Only cycle 1 ran (2 calls), abort during delay prevented cycle 2
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);

    vi.useRealTimers();
  });

  it("T9: safety cap prevents infinite loop", async () => {
    vi.useFakeTimers();
    const handleSingleModel = vi.fn().mockResolvedValue(makeResponse(500, { error: { message: "always fail" } }));

    const promise = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
      keepCycling: true,
      signal: new AbortController().signal, // Signal that never aborts
    });

    // Advance through all cycle delays
    await vi.runAllTimersAsync();

    const result = await promise;

    // Safety cap is 200 cycles × 2 models = 400 calls
    expect(handleSingleModel).toHaveBeenCalledTimes(400);
    expect(result.ok).toBe(false);
    expect([500, 503]).toContain(result.status);

    vi.useRealTimers();
  });
});
