"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Button, Select } from "@/shared/components";

const MODEL_STORAGE_KEY = "combos.assistant.model";

const TOOL_LABELS = {
  list_combos: "Listed combos",
  create_combo: "Created combo",
  update_combo: "Updated combo",
  delete_combo: "Deleted combo",
};

function describeAction(action) {
  const label = TOOL_LABELS[action.tool] || action.tool;
  const target = action.args?.new_name || action.args?.name || action.result?.name || action.result?.deleted || "";
  const suffix = target ? `: ${target}` : "";
  return action.ok ? `${label}${suffix}` : `${label} failed${action.result?.error ? ` (${action.result.error})` : ""}`;
}

// Chat box that lets a model create, read, update and delete combos via tool calls.
export default function ComboAssistant({ canWrite, onCombosChanged }) {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const options = (data.models || [])
          .map((m) => ({ value: m.routedModel || m.fullModel, label: m.routedModel || m.fullModel }))
          .filter((o) => o.value);
        const unique = [...new Map(options.map((o) => [o.value, o])).values()];
        setModels(unique);
        const saved = typeof window !== "undefined" ? window.localStorage.getItem(MODEL_STORAGE_KEY) : null;
        if (saved && unique.some((o) => o.value === saved)) setModel(saved);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, sending]);

  const handleModelChange = (e) => {
    setModel(e.target.value);
    try { window.localStorage.setItem(MODEL_STORAGE_KEY, e.target.value); } catch {}
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !model || sending || !canWrite) return;
    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const res = await fetch("/api/combos/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: next.filter((m) => !m.error).map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages([...next, { role: "assistant", content: data.error || "Request failed", error: true, actions: data.actions }]);
      } else {
        setMessages([...next, { role: "assistant", content: data.reply || "(no reply)", actions: data.actions }]);
      }
      if (data.changed) onCombosChanged?.();
    } catch (error) {
      setMessages([...next, { role: "assistant", content: error.message || "Request failed", error: true }]);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Card
      title="Combo Assistant"
      subtitle="Ask a model to create, edit or delete combos."
      icon="smart_toy"
    >
      <div className="flex flex-col gap-3">
        {messages.length > 0 && (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-live="polite">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[90%] whitespace-pre-wrap break-words rounded-[10px] px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "self-end bg-brand-500/10 text-text-main"
                    : m.error
                      ? "self-start bg-red-500/10 text-red-600 dark:text-red-400"
                      : "self-start bg-surface-2 text-text-main"
                }`}
              >
                {m.content}
                {m.actions?.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-0.5 border-t border-border-subtle pt-2 text-xs text-text-muted">
                    {m.actions.map((a, j) => (
                      <li key={j} className="flex items-center gap-1">
                        <span className={`material-symbols-outlined text-[14px] ${a.ok ? "text-green-600" : "text-red-500"}`}>
                          {a.ok ? "check_circle" : "error"}
                        </span>
                        {describeAction(a)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {sending && <div className="self-start text-xs text-text-muted">Working…</div>}
            <div ref={endRef} />
          </div>
        )}

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={!canWrite || sending}
          aria-label="Message to combo assistant"
          placeholder={canWrite ? 'e.g. "Create a combo named fast with cc/claude-sonnet-4-5 then openai/gpt-4o-mini"' : "Admin only"}
          className="w-full resize-y rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 text-[16px] text-text-main transition-all duration-150 placeholder:text-text-muted focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            className="min-w-0 sm:flex-1"
            aria-label="Model"
            options={models}
            value={model}
            onChange={handleModelChange}
            placeholder={models.length ? "Select a model" : "Loading models…"}
            disabled={!canWrite || sending}
          />
          <Button
            icon="send"
            onClick={handleSend}
            loading={sending}
            disabled={!canWrite || !model || !input.trim()}
            className="w-full sm:w-auto"
            title={!canWrite ? "Admin only" : !model ? "Select a model first" : undefined}
          >
            Send
          </Button>
        </div>
      </div>
    </Card>
  );
}
