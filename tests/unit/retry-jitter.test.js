/**
 * Unit tests: retry utility (addJitter, abortableSleep, fetchWithRetry)
 *
 * Verifies:
 * 1. addJitter produces values within expected ranges
 * 2. abortableSleep resolves early on abort
 * 3. fetchWithRetry retries on network errors and specified status codes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { addJitter, abortableSleep, withRetry, fetchWithRetry } from "open-sse/utils/retry.js";

describe("addJitter", () => {
  it("full mode: returns value between 0 and delay", () => {
    const delay = 1000;
    for (let i = 0; i < 100; i++) {
      const jittered = addJitter(delay, { mode: 'full' });
      expect(jittered).toBeGreaterThanOrEqual(0);
      expect(jittered).toBeLessThanOrEqual(delay);
    }
  });

  it("equal mode: returns value between delay/2 and delay", () => {
    const delay = 1000;
    for (let i = 0; i < 100; i++) {
      const jittered = addJitter(delay, { mode: 'equal' });
      expect(jittered).toBeGreaterThanOrEqual(delay / 2);
      expect(jittered).toBeLessThanOrEqual(delay);
    }
  });

  it("respects cap parameter", () => {
    const delay = 10000;
    const cap = 5000;
    for (let i = 0; i < 100; i++) {
      const jittered = addJitter(delay, { cap, mode: 'full' });
      expect(jittered).toBeLessThanOrEqual(cap);
    }
  });

  it("never returns negative values", () => {
    const delay = 1000;
    for (let i = 0; i < 100; i++) {
      const jittered = addJitter(delay);
      expect(jittered).toBeGreaterThanOrEqual(0);
    }
  });

  it("produces varied output (not always the same)", () => {
    const delay = 1000;
    const results = new Set();
    for (let i = 0; i < 50; i++) {
      results.add(Math.floor(addJitter(delay, { mode: 'full' }) / 10));
    }
    // Should have at least 10 different buckets out of 50 samples
    expect(results.size).toBeGreaterThan(10);
  });
});

describe("abortableSleep", () => {
  it("resolves normally without signal", async () => {
    const start = Date.now();
    const { aborted } = await abortableSleep(50);
    const elapsed = Date.now() - start;
    expect(aborted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it("resolves immediately if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const { aborted } = await abortableSleep(1000, controller.signal);
    const elapsed = Date.now() - start;
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  it("resolves early when signal aborts during sleep", async () => {
    const controller = new AbortController();
    const promise = abortableSleep(1000, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const start = Date.now();
    const { aborted } = await promise;
    const elapsed = Date.now() - start;
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });

  it("works without signal parameter", async () => {
    const { aborted } = await abortableSleep(50, undefined);
    expect(aborted).toBe(false);
  });
});

describe("withRetry", () => {
  it("succeeds on first try", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const { result, attempts, totalRetryMs } = await withRetry(fn);
    expect(result).toBe("success");
    expect(attempts).toBe(1);
    expect(totalRetryMs).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds on second try", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("fail");
      return "success";
    });

    const promise = withRetry(fn, { baseDelay: 100, maxRetries: 2 });
    await vi.runAllTimersAsync();
    const { result, attempts } = await promise;

    expect(result).toBe("success");
    expect(attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("exhausts retries and throws", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error("always fail"));

    const promise = withRetry(fn, { baseDelay: 100, maxRetries: 2 });
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow("always fail");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.useRealTimers();
  });

  it("respects shouldRetry returning false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("no retry"));
    const shouldRetry = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, { shouldRetry, maxRetries: 2 })).rejects.toThrow("no retry");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it("aborts during delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    const promise = withRetry(fn, {
      baseDelay: 1000,
      maxRetries: 2,
      signal: controller.signal,
    });

    // Let first attempt fail, then abort during retry delay
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow(/aborted during retry/);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("aborts before attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue("success");

    await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow(/aborted before attempt/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls onRetry callback with correct args", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) throw new Error("fail");
      return "success";
    });
    const onRetry = vi.fn();

    const promise = withRetry(fn, { baseDelay: 100, maxRetries: 3, onRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1); // attempt 1
    expect(onRetry.mock.calls[1][0]).toBe(2); // attempt 2
    vi.useRealTimers();
  });

  it("does not retry AbortError", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow("aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry", () => {
  it("retries on 502", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response("", { status: 502 });
      return new Response("ok", { status: 200 });
    });

    const promise = fetchWithRetry("https://example.com", {}, {
      fetch: mockFetch,
      baseDelay: 100,
      maxRetries: 2,
    });
    await vi.runAllTimersAsync();
    const { result } = await promise;

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not retry on 400", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 400 }));

    const { result } = await fetchWithRetry("https://example.com", {}, {
      fetch: mockFetch,
      maxRetries: 2,
    });

    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on network errors", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("ECONNRESET");
        err.code = "ECONNRESET";
        throw err;
      }
      return new Response("ok", { status: 200 });
    });

    const promise = fetchWithRetry("https://example.com", {}, {
      fetch: mockFetch,
      baseDelay: 100,
      maxRetries: 2,
    });
    await vi.runAllTimersAsync();
    const { result } = await promise;

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("respects custom retryOnStatus", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response("", { status: 429 });
      return new Response("ok", { status: 200 });
    });

    const promise = fetchWithRetry("https://example.com", {}, {
      fetch: mockFetch,
      retryOnStatus: [429],
      baseDelay: 100,
      maxRetries: 2,
    });
    await vi.runAllTimersAsync();
    const { result } = await promise;

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("calls log.debug on retry", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response("", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    const log = { debug: vi.fn() };

    const promise = fetchWithRetry("https://example.com/test", {}, {
      fetch: mockFetch,
      baseDelay: 100,
      maxRetries: 2,
      log,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(log.debug).toHaveBeenCalledWith(
      'RETRY',
      expect.stringContaining('example.com')
    );
    vi.useRealTimers();
  });
});
