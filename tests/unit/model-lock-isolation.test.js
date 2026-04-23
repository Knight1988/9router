/**
 * Unit tests: model lock isolation in accountFallback
 *
 * Proves that model locks are keyed per-model (modelLock_${model}),
 * so a lock on model-A does not prevent model-B from being used.
 * This is the core invariant that makes same-provider / different-model
 * combo fallback work correctly.
 */

import { describe, it, expect } from "vitest";
import {
  buildModelLockUpdate,
  isModelLockActive,
  getEarliestModelLockUntil,
  MODEL_LOCK_ALL,
} from "open-sse/services/accountFallback.js";

describe("model lock isolation", () => {
  it("T1: lock on model-A does not affect model-B (same-provider scenario)", () => {
    const update = buildModelLockUpdate("claude-opus-4-5", 60_000);
    const conn = { ...update };

    expect(isModelLockActive(conn, "claude-opus-4-5")).toBe(true);
    // Different model on same provider — must NOT be blocked
    expect(isModelLockActive(conn, "claude-sonnet-4-5")).toBe(false);
  });

  it("T2: __all lock blocks every model", () => {
    // buildModelLockUpdate(null) writes modelLock___all
    const update = buildModelLockUpdate(null, 60_000);
    const conn = { ...update };

    expect(isModelLockActive(conn, "claude-opus-4-5")).toBe(true);
    expect(isModelLockActive(conn, "claude-sonnet-4-5")).toBe(true);
    expect(isModelLockActive(conn, "gpt-4o")).toBe(true);
  });

  it("T3: expired lock returns false", () => {
    const pastTime = new Date(Date.now() - 1000).toISOString();
    const conn = { modelLock_claude_opus: pastTime };

    expect(isModelLockActive(conn, "claude_opus")).toBe(false);
  });

  it("T4: getEarliestModelLockUntil ignores expired, returns active", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const future = new Date(Date.now() + 30_000).toISOString();
    const conn = {
      modelLock_model_old: past,
      modelLock_model_active: future,
    };

    const earliest = getEarliestModelLockUntil(conn);
    expect(earliest).toBe(future);
  });

  it("T4b: getEarliestModelLockUntil returns null when all locks expired", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const conn = { modelLock_model_old: past };

    expect(getEarliestModelLockUntil(conn)).toBeNull();
  });

  it("T5: two separate model locks do not cross-contaminate", () => {
    const updateA = buildModelLockUpdate("model-A", 60_000);
    const updateB = buildModelLockUpdate("model-B", 60_000);
    const conn = { ...updateA, ...updateB };

    expect(isModelLockActive(conn, "model-A")).toBe(true);
    expect(isModelLockActive(conn, "model-B")).toBe(true);
    // A third model on same hypothetical provider stays unlocked
    expect(isModelLockActive(conn, "model-C")).toBe(false);
  });
});
