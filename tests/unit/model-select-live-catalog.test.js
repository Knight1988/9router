import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelSelectModal from "@/shared/components/ModelSelectModal.js";

vi.mock("@/shared/components/Modal", () => ({ default: ({ children }) => children }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
vi.mock("@/shared/components/CapacityBadges", () => ({ default: () => null }));
vi.mock("@/shared/hooks/useModelCaps", () => ({ useModelCaps: () => ({ getCaps: () => ({}) }) }));

let renderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

async function openPicker(catalogResponse, options = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const connection = { id: "tech-account", provider: "techopenclaw", isActive: true, ...options.connection };
  const fetchMock = vi.fn(async (url) => {
    let body = {};
    if (url === "/api/providers") body = { connections: [connection] };
    if (url === "/api/combos") body = { combos: [] };
    if (url === "/api/provider-nodes") body = { nodes: [] };
    if (url === "/api/models/custom") body = { models: [] };
    if (url === "/api/models/disabled") body = { disabled: options.disabled || {} };
    if (url === "/api/providers/tech-account/models") {
      if (catalogResponse instanceof Error) throw catalogResponse;
      return { ok: true, json: async () => ({ models: catalogResponse }) };
    }
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  const onSelect = vi.fn();
  await act(async () => {
    renderer = create(React.createElement(ModelSelectModal, {
      isOpen: true, onClose: vi.fn(), onSelect, activeProviders: [connection], closeOnSelect: false,
    }));
  });
  return { fetchMock, onSelect };
}

function buttonFor(label) {
  const text = (node) => typeof node === "string" ? node : (node?.children || []).map(text).join("");
  return renderer.root.findAllByType("button").find((button) => text(button).includes(label));
}

describe("combo picker account catalog", () => {
  it("keeps the bundled fallback when the catalog request fails", async () => {
    await openPicker(new Error("catalog unavailable"));
    expect(Boolean(buttonFor("Claude Opus"))).toBe(true);
  });
  it("applies disabled and enabled model filters to the saved catalog", async () => {
    await openPicker([
      { id: "allowed", name: "Allowed Model" },
      { id: "disabled", name: "Disabled Model" },
      { id: "excluded", name: "Excluded Model" },
    ], {
      disabled: { techopenclaw: ["disabled"] },
      connection: { providerSpecificData: { enabledModels: ["allowed", "disabled"] } },
    });
    expect(Boolean(buttonFor("Allowed Model"))).toBe(true);
    expect(Boolean(buttonFor("Disabled Model"))).toBe(false);
    expect(Boolean(buttonFor("Excluded Model"))).toBe(false);
  });
  it("does not resurrect bundled models when the saved catalog is intentionally empty", async () => {
    await openPicker([]);
    expect(Boolean(buttonFor("Claude Opus"))).toBe(false);
  });
  it("renders and selects saved TechOpenClaw models absent from the bundled registry", async () => {
    const { fetchMock, onSelect } = await openPicker([{ id: "db-only-model", name: "DB Only Model" }]);
    const button = buttonFor("DB Only Model");
    expect(button, "saved catalog model must be rendered in Add Model").toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/providers/tech-account/models", { cache: "no-store" });
    await act(async () => button.props.onClick());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: "techopenclaw/db-only-model" }));
    expect(Boolean(buttonFor("Claude Opus 4.8"))).toBe(false);
  });
});
