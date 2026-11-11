import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const cursorConfig = vi.hoisted(() => ({
  agentEndpoint: "https://agent.api5.cursor.sh",
  modelsEndpoint: "/agent.v1.AgentService/GetUsableModels",
}));
vi.mock("../../open-sse/providers/index.js", () => ({
  PROVIDER_OAUTH: { cursor: cursorConfig },
}));
const cursorFetch = vi.hoisted(() => ({ status: 200, body: new Uint8Array(), calls: [] }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => {
    if (options?.directFetch) return global.fetch(url, options);
    cursorFetch.calls.push({ url, options });
    return Promise.resolve({
      ok: cursorFetch.status >= 200 && cursorFetch.status < 300,
      status: cursorFetch.status,
      arrayBuffer: async () => cursorFetch.body.buffer.slice(
        cursorFetch.body.byteOffset,
        cursorFetch.body.byteOffset + cursorFetch.body.byteLength,
      ),
    });
  },
}));
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

// GetUsableModels uses the proxy-aware fetch boundary; keep the account-specific
// model request in this test fully isolated from the network.
function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    cursorFetch.calls.length = 0;
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    cursorFetch.status = 200;
    const available = field(2, field(1, text("claude-4.6-opus")));
    cursorFetch.body = concat(model("claude-4.6-opus", "Claude 4.6 Opus"), available);
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{
        id: "claude-4.6-opus",
        name: "Claude 4.6 Opus",
        defaultOn: false,
        isChatOnly: false,
        supportsAgent: false,
        isHidden: false,
      }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{
        id: "claude-4.6-opus",
        name: "Claude 4.6 Opus",
        defaultOn: false,
        isChatOnly: false,
        supportsAgent: false,
        isHidden: false,
      }],
    });

    expect(cursorFetch.calls).toHaveLength(1);
    expect(cursorFetch.calls[0].url).toBe("https://agent.api5.cursor.sh/agent.v1.AgentService/GetUsableModels");
    expect(cursorFetch.calls[0].options).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "content-type": "application/proto",
        accept: "application/proto",
      }),
    }));
  });

  it("fails open when the Cursor catalog request fails", async () => {
    cursorFetch.status = 403;
    cursorFetch.body = new TextEncoder().encode("no");

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
    expect(cursorFetch.calls).toHaveLength(1);
  });
});
