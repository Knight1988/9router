import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ combos: [] }));

vi.mock("@/lib/localDb", () => ({
  getCombos: async () => store.combos,
  getComboById: async (id) => store.combos.find((c) => c.id === id) || null,
  getComboByName: async (name) => store.combos.find((c) => c.name === name) || null,
}));
vi.mock("@/app/api/models/test/ping", () => ({
  getInternalHeaders: async () => ({ "Content-Type": "application/json" }),
}));
vi.mock("../../src/app/api/combos/route.js", () => ({
  POST: async (req) => {
    const body = await req.json();
    const combo = { id: `id-${store.combos.length + 1}`, name: body.name, models: body.models, kind: null };
    store.combos.push(combo);
    return Response.json(combo, { status: 201 });
  },
}));
vi.mock("../../src/app/api/combos/[id]/route.js", () => ({
  PUT: async (req, { params }) => {
    const { id } = await params;
    const combo = store.combos.find((c) => c.id === id);
    Object.assign(combo, await req.json());
    return Response.json(combo);
  },
  DELETE: async (_req, { params }) => {
    const { id } = await params;
    store.combos = store.combos.filter((c) => c.id !== id);
    return Response.json({ success: true });
  },
}));

const { POST } = await import("../../src/app/api/combos/assistant/route.js");

const toolCall = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const modelReply = (message) =>
  new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
const call = (body) =>
  POST(new Request("http://localhost/api/combos/assistant", { method: "POST", body: JSON.stringify(body) }));

describe("combo assistant route", () => {
  beforeEach(() => {
    store.combos = [{ id: "c1", name: "old", models: ["a/x"], kind: null }];
    vi.restoreAllMocks();
  });

  it("runs create, update and delete tool calls then returns the final reply", async () => {
    const replies = [
      modelReply({ content: null, tool_calls: [toolCall("t1", "create_combo", { name: "fast", models: ["a/y"] })] }),
      modelReply({ content: null, tool_calls: [toolCall("t2", "update_combo", { name: "fast", models: ["a/y", "b/z"] })] }),
      modelReply({ content: null, tool_calls: [toolCall("t3", "delete_combo", { name: "old" })] }),
      modelReply({ content: "done" }),
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => replies.shift());

    const res = await call({ model: "a/m", messages: [{ role: "user", content: "go" }] });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.reply).toBe("done");
    expect(data.changed).toBe(true);
    expect(data.actions.map((a) => [a.tool, a.ok])).toEqual([
      ["create_combo", true],
      ["update_combo", true],
      ["delete_combo", true],
    ]);
    expect(store.combos).toEqual([{ id: "id-2", name: "fast", models: ["a/y", "b/z"], kind: null }]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).tools).toHaveLength(4);
  });

  it("reports an error result for an unknown combo without marking changed", async () => {
    const replies = [
      modelReply({ content: null, tool_calls: [toolCall("t1", "delete_combo", { name: "missing" })] }),
      modelReply({ content: "not found" }),
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => replies.shift());

    const data = await (await call({ model: "a/m", messages: [{ role: "user", content: "x" }] })).json();
    expect(data.changed).toBe(false);
    expect(data.actions[0]).toMatchObject({ tool: "delete_combo", ok: false });
  });

  it("rejects missing model and non-user-terminated history", async () => {
    expect((await call({ messages: [{ role: "user", content: "x" }] })).status).toBe(400);
    expect((await call({ model: "a/m", messages: [{ role: "assistant", content: "x" }] })).status).toBe(400);
  });
});
