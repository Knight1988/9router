/**
 * Unit tests: combo retry with exponential backoff
 *
 * Verifies that handleComboChat:
 * 1. Logs [RETRY] warning on cycle restart
 * 2. Uses exponential backoff between cycles (1.5s → 3s → 6s → ...)
 * 3. Caps backoff at 60s
 * 4. Succeeds on a later cycle after initial failures
 * 5. Safety cap of 200 cycles still applies
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MODEL_A = "anthropic/claude-opus-4-5";
const MODEL_B = "anthropic/claude-sonnet-4-5";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("combo retry — exponential backoff between cycles", () => {
  it("T1: logs [RETRY] warning when cycle restarts", async () => {
    vi.useFakeTimers();
    let callCount = 0;

    const handleSingleModel = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 3) {
        // succeed on cycle 2, model A
        return makeResponse(200, { choices: [{ message: { content: "ok" } }] });
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

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    // Should have logged a [RETRY] warning for cycle 1 exhaustion
    const warnCalls = log.warn.mock.calls.map(c => c.join(" "));
    expect(warnCalls.some(m => m.includes("[RETRY]") && m.includes("Cycle 1"))).toBe(true);

    vi.useRealTimers();
  });

  it("T2: first cycle delay is 1500ms (base)", async () => {
    vi.useFakeTimers();
    const delays = [];
    let callCount = 0;

    const handleSingleModel = vi.fn().mockImplementation(async () => {
      callCount++;
      // Succeed on cycle 2 model A (call 3)
      if (callCount === 3) return makeResponse(200, { choices: [{ message: { content: "ok" } }] });
      return makeResponse(500, { error: { message: "fail" } });
    });

    // Spy on setTimeout to capture delay values
    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
      if (typeof ms === "number" && ms > 100) delays.push(ms);
      return origSetTimeout(fn, 0, ...args); // run immediately
    });

    const promise = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
      keepCycling: true,
      signal: new AbortController().signal,
    });

    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();

    // First inter-cycle delay should be 1500ms
    expect(delays[0]).toBe(1500);

    vi.useRealTimers();
  });

  it("T3: second cycle delay is 3000ms (2x base)", async () => {
    vi.useFakeTimers();
    const delays = [];
    let callCount = 0;

    const handleSingleModel = vi.fn().mockImplementation(async () => {
      callCount++;
      // Succeed on cycle 3 model A (call 5)
      if (callCount === 5) return makeResponse(200, { choices: [{ message: { content: "ok" } }] });
      return makeResponse(500, { error: { message: "fail" } });
    });

    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
      if (typeof ms === "number" && ms > 100) delays.push(ms);
      return origSetTimeout(fn, 0, ...args);
    });

    const promise = handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
      keepCycling: true,
      signal: new AbortController().signal,
    });

    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();

    // Delays: cycle 1→2 = 1500ms, cycle 2→3 = 3000ms
    expect(delays[0]).toBe(1500);
    expect(delays[1]).toBe(3000);

    vi.useRealTimers();
  });

  it("T4: backoff caps at 60000ms", async () => {
    vi.useFakeTimers();
    const delays = [];
    // Need enough cycles to hit the cap: 1500 * 2^n >= 60000 → n >= 6 → cycle 7+
    // Use 3 models to reach cap faster, succeed on cycle 8
    const MODELS = ["a", "b", "c", "d", "e", "f"];
    let callCount = 0;
    const totalBeforeCap = MODELS.length * 7; // 7 full cycles

    const handleSingleModel = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount > totalBeforeCap) return makeResponse(200, { choices: [{ message: { content: "ok" } }] });
      return makeResponse(500, { error: { message: "fail" } });
    });

    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
      if (typeof ms === "number" && ms > 100) delays.push(ms);
      return origSetTimeout(fn, 0, ...args);
    });

    const promise = handleComboChat({
      body: {},
      models: MODELS,
      handleSingleModel,
      log,
      keepCycling: true,
      signal: new AbortController().signal,
    });

    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();

    // After enough cycles, delay should be capped at 60000ms
    const maxDelay = Math.max(...delays);
    expect(maxDelay).toBe(60000);

    vi.useRealTimers();
  });

  it("T5: safety cap of 200 cycles still applies with backoff", async () => {
    vi.useFakeTimers();

    const handleSingleModel = vi.fn().mockResolvedValue(
      makeResponse(500, { error: { message: "always fail" } })
    );

    const promise = handleComboChat({
      body: {},
      models: [MODEL_A, MODEL_B],
      handleSingleModel,
      log,
      keepCycling: true,
      signal: new AbortController().signal,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    // 200 cycles × 2 models = 400 calls
    expect(handleSingleModel).toHaveBeenCalledTimes(400);
    expect(result.ok).toBe(false);

    // Safety cap warning logged
    const warnCalls = log.warn.mock.calls.map(c => c.join(" "));
    expect(warnCalls.some(m => m.includes("Safety cap"))).toBe(true);

    vi.useRealTimers();
  });
});
