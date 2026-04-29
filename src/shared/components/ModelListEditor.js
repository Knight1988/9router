"use client";
import { useState, useEffect } from "react";
import { ModelSelectModal } from "@/shared/components";

const EMPTY_PROVIDERS = [];
// Inline-editable single model row
function ModelItem({ index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };
  return (
    <div className="group flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors">
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-0 px-1.5 py-0.5 text-xs font-mono bg-white dark:bg-black/20 border border-primary/40 rounded outline-none text-text-main"
        />
      ) : (
        <div
          className="flex-1 min-w-0 px-1.5 py-0.5 text-xs font-mono text-text-main truncate cursor-text hover:bg-black/5 dark:hover:bg-white/5 rounded"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {model}
        </div>
      )}
      <div className="flex items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move up"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move down"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
        title="Remove"
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}
/**
 * Reusable ordered model list editor.
 * Props:
 *   models: string[]          — current list
 *   onChange: (string[]) => void
 *   disabled?: boolean
 *   emptyIcon?: string        — material symbol name (default: "layers")
 *   emptyLabel?: string       — placeholder text when list is empty
 *   addLabel?: string         — label on the Add button (default: "Add Model")
 *   modalTitle?: string       — title for ModelSelectModal
 */
export function ModelListEditor({
  models,
  onChange,
  disabled,
  activeProviders = EMPTY_PROVIDERS,
  emptyIcon = "layers",
  emptyLabel = "No models added yet",
  addLabel = "Add Model",
  modalTitle = "Select Model",
}) {
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [fetchedProviders, setFetchedProviders] = useState(null);
  useEffect(() => {
    fetch("/api/models/alias")
      .then((r) => r.ok ? r.json() : {})
      .then((d) => setModelAliases(d.aliases || {}))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (activeProviders.length > 0) {
      setFetchedProviders(null);
      return;
    }
    let cancelled = false;
    fetch("/api/providers")
      .then((r) => r.ok ? r.json() : {})
      .then((d) => { if (!cancelled) setFetchedProviders(d.connections || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeProviders]);
  const resolvedActiveProviders = activeProviders.length > 0 ? activeProviders : (fetchedProviders ?? EMPTY_PROVIDERS);
  const handleAddModel = (model) => {
    if (!models.includes(model.value)) {
      onChange([...models, model.value]);
    }
  };
  const handleRemove = (index) => onChange(models.filter((_, i) => i !== index));
  const handleMoveUp = (index) => {
    if (index === 0) return;
    const next = [...models];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onChange(next);
  };
  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const next = [...models];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onChange(next);
  };
  const handleEdit = (index, newVal) => {
    const next = [...models];
    next[index] = newVal;
    onChange(next);
  };
  return (
    <>
      {models.length === 0 ? (
        <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
          <span className="material-symbols-outlined text-text-muted text-xl mb-1">{emptyIcon}</span>
          <p className="text-xs text-text-muted">{emptyLabel}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-[350px] overflow-y-auto">
          {models.map((model, index) => (
            <ModelItem
              key={index}
              index={index}
              model={model}
              isFirst={index === 0}
              isLast={index === models.length - 1}
              onEdit={(v) => handleEdit(index, v)}
              onMoveUp={() => handleMoveUp(index)}
              onMoveDown={() => handleMoveDown(index)}
              onRemove={() => handleRemove(index)}
            />
          ))}
        </div>
      )}
      <button
        disabled={disabled}
        onClick={() => setShowModelSelect(true)}
        className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="material-symbols-outlined text-[16px]">add</span>
        {addLabel}
      </button>
      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => setShowModelSelect(false)}
        onSelect={handleAddModel}
        activeProviders={resolvedActiveProviders}
        modelAliases={modelAliases}
        title={modalTitle}
      />
    </>
  );
}
