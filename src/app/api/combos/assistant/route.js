import { NextResponse } from "next/server";
import { getCombos, getComboById, getComboByName } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getInternalHeaders } from "@/app/api/models/test/ping";
import { POST as createComboRoute } from "../route.js";
import { PUT as updateComboRoute, DELETE as deleteComboRoute } from "../[id]/route.js";

export const dynamic = "force-dynamic";

const MAX_STEPS = 6;
const MAX_HISTORY = 40;
const MAX_MESSAGE_CHARS = 8000;
const STEP_TIMEOUT_MS = 120000;

const SYSTEM_PROMPT = `You manage the model combos of a local AI routing gateway through tools.
A combo is a named list of models. Requests sent to the combo name are routed through its models in order.
Model ids look like "<provider-alias>/<model-id>", for example "cc/claude-opus-4-5" or "openai/gpt-4o".
Combo names may only contain letters, numbers, "-", "_" and ".".
Rules:
- Call list_combos before updating or deleting so you act on the real current state.
- Use only the tools to change combos. Never claim a change happened unless the tool result says so.
- Delete a combo only when the user explicitly asks for it.
- Keep answers short. Report what changed.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_combos",
      description: "List all LLM combos with id, name and ordered models.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_combo",
      description: "Create a new combo.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique combo name." },
          models: { type: "array", items: { type: "string" }, description: "Ordered model ids." },
        },
        required: ["name", "models"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_combo",
      description: "Rename a combo and/or replace its model list. Identify it by id or current name.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", description: "Current combo name (used when id is not given)." },
          new_name: { type: "string" },
          models: { type: "array", items: { type: "string" }, description: "Full replacement list of model ids." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_combo",
      description: "Delete a combo. Identify it by id or name.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
  },
];

const isLlmCombo = (c) => !c.kind || c.kind === "llm";

async function resolveCombo({ id, name }) {
  let combo = null;
  if (id) combo = await getComboById(String(id));
  if (!combo && name) combo = await getComboByName(String(name));
  if (!combo || !isLlmCombo(combo)) return null;
  return combo;
}

function cleanModels(models) {
  if (!Array.isArray(models)) return null;
  const out = models.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean);
  return out.length === models.length ? out : null;
}

async function readRouteResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data?.error || `Request failed (${res.status})` };
  return data;
}

const jsonRequest = (method, body) =>
  new Request("http://localhost/api/combos", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Returns { result, mutated } for one tool call. Delegates writes to the same
// route handlers the dashboard uses so validation and cache invalidation match.
async function runTool(name, args) {
  switch (name) {
    case "list_combos": {
      const combos = (await getCombos()).filter(isLlmCombo);
      return { result: { combos: combos.map(({ id, name, models }) => ({ id, name, models })) }, mutated: false };
    }
    case "create_combo": {
      const models = cleanModels(args.models);
      if (!args.name || !models) return { result: { error: "name and a string array models are required" }, mutated: false };
      const data = await readRouteResponse(await createComboRoute(jsonRequest("POST", { name: args.name, models })));
      return { result: data.error ? data : { id: data.id, name: data.name, models: data.models }, mutated: !data.error };
    }
    case "update_combo": {
      const combo = await resolveCombo(args);
      if (!combo) return { result: { error: "Combo not found" }, mutated: false };
      const body = {};
      if (args.new_name !== undefined) body.name = args.new_name;
      if (args.models !== undefined) {
        const models = cleanModels(args.models);
        if (!models) return { result: { error: "models must be an array of strings" }, mutated: false };
        body.models = models;
      }
      if (!Object.keys(body).length) return { result: { error: "Nothing to update" }, mutated: false };
      const data = await readRouteResponse(
        await updateComboRoute(jsonRequest("PUT", body), { params: Promise.resolve({ id: combo.id }) })
      );
      return { result: data.error ? data : { id: data.id, name: data.name, models: data.models }, mutated: !data.error };
    }
    case "delete_combo": {
      const combo = await resolveCombo(args);
      if (!combo) return { result: { error: "Combo not found" }, mutated: false };
      const data = await readRouteResponse(
        await deleteComboRoute(jsonRequest("DELETE"), { params: Promise.resolve({ id: combo.id }) })
      );
      return { result: data.error ? data : { deleted: combo.name }, mutated: !data.error };
    }
    default:
      return { result: { error: `Unknown tool: ${name}` }, mutated: false };
  }
}

function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return null;
  const clean = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
  return clean.length && clean[clean.length - 1].role === "user" ? clean : null;
}

// POST /api/combos/assistant - Let a model manage combos through tool calls
export async function POST(request) {
  try {
    const body = await request.json();
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const history = sanitizeHistory(body.messages);
    if (!model) return NextResponse.json({ error: "Model is required" }, { status: 400 });
    if (!history) return NextResponse.json({ error: "A user message is required" }, { status: 400 });

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
    const headers = await getInternalHeaders();
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
    const actions = [];
    let changed = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, stream: false, messages, tools: TOOLS }),
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      const raw = await res.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch {}
      if (!res.ok) {
        const detail = parsed?.error?.message || parsed?.error || raw;
        return NextResponse.json(
          { error: `Model call failed (HTTP ${res.status}): ${String(detail).slice(0, 300)}`, actions, changed },
          { status: 502 }
        );
      }

      const message = parsed?.choices?.[0]?.message;
      if (!message) {
        return NextResponse.json({ error: "Model returned no message", actions, changed }, { status: 502 });
      }

      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        return NextResponse.json({ reply: typeof message.content === "string" ? message.content : "", actions, changed });
      }

      messages.push({ role: "assistant", content: message.content || null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        let args = {};
        try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch {
          args = null;
        }
        const out = args === null
          ? { result: { error: "Tool arguments were not valid JSON" }, mutated: false }
          : await runTool(name, args).catch((err) => ({ result: { error: err.message }, mutated: false }));
        if (out.mutated) changed = true;
        actions.push({ tool: name, args: args || {}, ok: !out.result?.error, result: out.result });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.result) });
      }
    }

    return NextResponse.json({ reply: "Stopped after reaching the tool-call step limit.", actions, changed });
  } catch (error) {
    console.log("Error in combo assistant:", error);
    return NextResponse.json({ error: "Combo assistant failed" }, { status: 500 });
  }
}
