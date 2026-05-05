/**
 * Unit tests for thinking config normalization in filterToOpenAIFormat
 * (open-sse/translator/helpers/openaiHelper.js)
 *
 * Covers the chokepoint that fixes the [400] thinking.enabled.budget_tokens: Field required
 * error for OpenAI-compat Claude gateway providers (open-claude, troll-llm) where the
 * Claude-format prepareClaudeRequest normalizer never runs.
 */

import { describe, it, expect } from "vitest";
import { filterToOpenAIFormat } from "../../open-sse/translator/helpers/openaiHelper.js";

function makeBody(thinking, extra = {}) {
  return {
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    ...(thinking !== undefined ? { thinking } : {}),
    ...extra,
  };
}

describe("filterToOpenAIFormat – thinking normalization for open-claude / troll-llm", () => {
  for (const provider of ["open-claude", "troll-llm"]) {
    describe(`provider=${provider}`, () => {
      it("injects default budget_tokens when type=enabled and budget_tokens is absent", () => {
        const body = makeBody({ type: "enabled" });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.type).toBe("enabled");
        expect(result.thinking.budget_tokens).toBe(10000);
      });

      it("preserves existing budget_tokens when type=enabled and valid", () => {
        const body = makeBody({ type: "enabled", budget_tokens: 5000 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.type).toBe("enabled");
        expect(result.thinking.budget_tokens).toBe(5000);
      });

      it("injects default budget_tokens when type=enabled and budget_tokens is 0", () => {
        const body = makeBody({ type: "enabled", budget_tokens: 0 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.budget_tokens).toBe(10000);
      });

      it("injects default budget_tokens when type=enabled and budget_tokens is negative", () => {
        const body = makeBody({ type: "enabled", budget_tokens: -1 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.budget_tokens).toBe(10000);
      });

      it("removes budget_tokens when type=disabled", () => {
        const body = makeBody({ type: "disabled", budget_tokens: 5000 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.type).toBe("disabled");
        expect(result.thinking.budget_tokens).toBeUndefined();
      });

      it("defaults type to enabled and injects budget_tokens when type is missing", () => {
        const body = makeBody({ budget_tokens: 0 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.type).toBe("enabled");
        expect(result.thinking.budget_tokens).toBe(10000);
      });

      it("leaves thinking untouched when no thinking key present", () => {
        const body = makeBody(undefined);
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking).toBeUndefined();
      });

      it("coalesces camelCase budgetTokens into budget_tokens", () => {
        const body = makeBody({ type: "enabled", budgetTokens: 5000 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.type).toBe("enabled");
        expect(result.thinking.budget_tokens).toBe(5000);
        expect(result.thinking.budgetTokens).toBeUndefined();
      });

      it("injects default when budgetTokens is 0 (camelCase)", () => {
        const body = makeBody({ type: "enabled", budgetTokens: 0 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.budget_tokens).toBe(10000);
        expect(result.thinking.budgetTokens).toBeUndefined();
      });

      it("snake_case wins when both budget_tokens and budgetTokens are present", () => {
        const body = makeBody({ type: "enabled", budget_tokens: 5000, budgetTokens: 8000 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.budget_tokens).toBe(5000);
        expect(result.thinking.budgetTokens).toBeUndefined();
      });

      it("strips budgetTokens when type=disabled", () => {
        const body = makeBody({ type: "disabled", budgetTokens: 5000 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.type).toBe("disabled");
        expect(result.thinking.budget_tokens).toBeUndefined();
        expect(result.thinking.budgetTokens).toBeUndefined();
      });

      it("coalesces budgetTokens when type is missing", () => {
        const body = makeBody({ budgetTokens: 7000 });
        const result = filterToOpenAIFormat(body, provider);
        expect(result.thinking.type).toBe("enabled");
        expect(result.thinking.budget_tokens).toBe(7000);
        expect(result.thinking.budgetTokens).toBeUndefined();
      });
    });
  }

  describe("provider=openai (no normalization)", () => {
    it("does NOT inject budget_tokens for non-Claude-gateway providers", () => {
      const body = makeBody({ type: "enabled" });
      const result = filterToOpenAIFormat(body, "openai");
      expect(result.thinking.budget_tokens).toBeUndefined();
    });
  });
});
