/**
 * Unit tests: expandComboModels — recursive sub-combo expansion
 *
 * Covers:
 *  - Leaf strings (with "/") pass through unchanged
 *  - Unknown name (no combo match) treated as alias leaf
 *  - Flat combo expands to its models
 *  - Nested combo: parent contains sub-combo name → expands to sub's leaves
 *  - Deep nesting (3 levels)
 *  - Cycle A→B→A → breaks with warning, returns leaves seen so far
 *  - Dedup: two sub-combos sharing a leaf → leaf appears once (first wins)
 *  - Mixed: parent [subCombo, leaf] → sub leaves first, then leaf
 *  - getComboModelsFromData: returns null for non-combo, flat leaves for combo
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { expandComboModels, getComboModelsFromData } from "open-sse/services/combo.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeMap(combos) {
  const m = new Map(combos.map(c => [c.name, c]));
  return (name) => m.get(name) ?? null;
}

// ─── expandComboModels ───────────────────────────────────────────────────────

describe("expandComboModels", () => {
  it("E1: leaf string (contains /) passes through unchanged", async () => {
    const lookup = vi.fn().mockReturnValue(null);
    const result = await expandComboModels("anthropic/claude-3-5-sonnet", lookup);
    expect(result).toEqual(["anthropic/claude-3-5-sonnet"]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("E2: unknown name (no combo match) treated as alias leaf", async () => {
    const lookup = vi.fn().mockReturnValue(null);
    const result = await expandComboModels("my-alias", lookup);
    expect(result).toEqual(["my-alias"]);
    expect(lookup).toHaveBeenCalledWith("my-alias");
  });

  it("E3: flat combo expands to its leaf models", async () => {
    const lookup = makeMap([
      { name: "my-combo", models: ["anthropic/claude-opus-4", "openai/gpt-4o"] },
    ]);
    const result = await expandComboModels("my-combo", lookup);
    expect(result).toEqual(["anthropic/claude-opus-4", "openai/gpt-4o"]);
  });

  it("E4: nested combo — parent contains sub-combo name", async () => {
    const lookup = makeMap([
      { name: "sub", models: ["anthropic/claude-3-5-sonnet", "openai/gpt-4o-mini"] },
      { name: "parent", models: ["sub", "google/gemini-2.0-flash"] },
    ]);
    const result = await expandComboModels("parent", lookup);
    expect(result).toEqual([
      "anthropic/claude-3-5-sonnet",
      "openai/gpt-4o-mini",
      "google/gemini-2.0-flash",
    ]);
  });

  it("E5: deep nesting (3 levels)", async () => {
    const lookup = makeMap([
      { name: "leaf-combo", models: ["p1/m1", "p2/m2"] },
      { name: "mid-combo", models: ["leaf-combo", "p3/m3"] },
      { name: "top-combo", models: ["mid-combo", "p4/m4"] },
    ]);
    const result = await expandComboModels("top-combo", lookup);
    expect(result).toEqual(["p1/m1", "p2/m2", "p3/m3", "p4/m4"]);
  });

  it("E6: cycle A→B→A breaks with warning, returns leaves seen so far", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = makeMap([
      { name: "comboA", models: ["comboB", "p1/m1"] },
      { name: "comboB", models: ["comboA", "p2/m2"] },
    ]);
    const result = await expandComboModels("comboA", lookup);
    // comboA → comboB → comboA (cycle, skip) → p2/m2 → p1/m1
    expect(result).toEqual(["p2/m2", "p1/m1"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Cycle detected"));
  });

  it("E7: dedup — two sub-combos sharing a leaf, first occurrence wins", async () => {
    const lookup = makeMap([
      { name: "subA", models: ["p1/m1", "p2/m2"] },
      { name: "subB", models: ["p2/m2", "p3/m3"] }, // p2/m2 is shared
      { name: "parent", models: ["subA", "subB"] },
    ]);
    const result = await expandComboModels("parent", lookup);
    expect(result).toEqual(["p1/m1", "p2/m2", "p3/m3"]);
    // p2/m2 appears only once (from subA)
    expect(result.filter(m => m === "p2/m2")).toHaveLength(1);
  });

  it("E8: mixed — parent [subCombo, leaf] → sub leaves first, then leaf", async () => {
    const lookup = makeMap([
      { name: "sub", models: ["p1/m1", "p2/m2"] },
      { name: "parent", models: ["sub", "p3/m3"] },
    ]);
    const result = await expandComboModels("parent", lookup);
    expect(result).toEqual(["p1/m1", "p2/m2", "p3/m3"]);
  });

  it("E9: empty combo returns empty array", async () => {
    const lookup = makeMap([
      { name: "empty-combo", models: [] },
    ]);
    const result = await expandComboModels("empty-combo", lookup);
    expect(result).toEqual([]);
  });

  it("E10: dedup across top-level leaf and sub-combo leaf", async () => {
    const lookup = makeMap([
      { name: "sub", models: ["p1/m1", "p2/m2"] },
      { name: "parent", models: ["sub", "p1/m1"] }, // p1/m1 also listed directly
    ]);
    const result = await expandComboModels("parent", lookup);
    expect(result).toEqual(["p1/m1", "p2/m2"]);
  });
});

// ─── getComboModelsFromData ──────────────────────────────────────────────────

describe("getComboModelsFromData", () => {
  it("G1: returns null for provider/model string", async () => {
    const result = await getComboModelsFromData("anthropic/claude-3-5-sonnet", []);
    expect(result).toBeNull();
  });

  it("G2: returns null when name not found in combos", async () => {
    const result = await getComboModelsFromData("unknown", [
      { name: "other", models: ["p1/m1"] },
    ]);
    expect(result).toBeNull();
  });

  it("G3: returns null for combo with empty models", async () => {
    const result = await getComboModelsFromData("empty", [
      { name: "empty", models: [] },
    ]);
    expect(result).toBeNull();
  });

  it("G4: returns flat leaf list for a simple combo", async () => {
    const result = await getComboModelsFromData("my-combo", [
      { name: "my-combo", models: ["p1/m1", "p2/m2"] },
    ]);
    expect(result).toEqual(["p1/m1", "p2/m2"]);
  });

  it("G5: expands nested sub-combo", async () => {
    const result = await getComboModelsFromData("parent", [
      { name: "sub", models: ["p1/m1", "p2/m2"] },
      { name: "parent", models: ["sub", "p3/m3"] },
    ]);
    expect(result).toEqual(["p1/m1", "p2/m2", "p3/m3"]);
  });

  it("G6: accepts object format { combos: [...] }", async () => {
    const result = await getComboModelsFromData("my-combo", {
      combos: [{ name: "my-combo", models: ["p1/m1"] }],
    });
    expect(result).toEqual(["p1/m1"]);
  });
});
