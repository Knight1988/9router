/**
 * Unit tests for thinking config normalization in prepareClaudeRequest
 * (open-sse/translator/helpers/claudeHelper.js)
 *
 * Covers the chokepoint that fixes the [400] thinking.enabled.budget_tokens: Field required
 * error for all source formats (including Claude→Claude passthrough where openai-to-claude
 * never runs).
 */

import { describe, it, expect } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";

function makeBody(thinking, extra = {}) {
  return {
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    thinking,
    ...extra,
  };
}

describe("prepareClaudeRequest – thinking normalization", () => {
  it("injects default budget_tokens when type=enabled and budget_tokens is absent", () => {
    const body = makeBody({ type: "enabled" });
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking.type).toBe("enabled");
    expect(result.thinking.budget_tokens).toBe(10000);
  });

  it("preserves existing budget_tokens when type=enabled and valid", () => {
    const body = makeBody({ type: "enabled", budget_tokens: 5000 });
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking.type).toBe("enabled");
    expect(result.thinking.budget_tokens).toBe(5000);
  });

  it("injects default budget_tokens when type=enabled and budget_tokens is 0", () => {
    const body = makeBody({ type: "enabled", budget_tokens: 0 });
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking.budget_tokens).toBe(10000);
  });

  it("injects default budget_tokens when type=enabled and budget_tokens is negative", () => {
    const body = makeBody({ type: "enabled", budget_tokens: -1 });
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking.budget_tokens).toBe(10000);
  });

  it("removes budget_tokens when type=disabled", () => {
    const body = makeBody({ type: "disabled", budget_tokens: 5000 });
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking.type).toBe("disabled");
    expect(result.thinking.budget_tokens).toBeUndefined();
  });

  it("defaults type to enabled and injects budget_tokens when type is missing", () => {
    const body = makeBody({ budget_tokens: 0 });
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking.type).toBe("enabled");
    expect(result.thinking.budget_tokens).toBe(10000);
  });

  it("leaves body unchanged when thinking is undefined", () => {
    const body = makeBody(undefined);
    delete body.thinking;
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking).toBeUndefined();
  });

  it("leaves body unchanged when thinking is null", () => {
    const body = makeBody(null);
    const result = prepareClaudeRequest(body, "claude", null, null, { setCacheKey: false });
    expect(result.thinking).toBeNull();
  });
});
