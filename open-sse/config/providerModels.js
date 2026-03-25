import { PROVIDERS } from "./providers.js";

// Provider models - Single source of truth
// Key = alias (cc, cx, gc, qw, if, ag, gh for OAuth; id for API Key)
// Field "provider" for special cases (e.g. AntiGravity models that call different backends)

export const PROVIDER_MODELS = {
  // OAuth Providers (using alias)
  cc: [ // Claude Code
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-5-20251101", name: "Claude 4.5 Opus" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude 4.5 Sonnet" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
  ],
  cx: [ // OpenAI Codex
    { id: "gpt-5.4", name: "GPT 5.4" },
    // GPT 5.3 Codex - all thinking levels
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    { id: "gpt-5.3-codex-xhigh", name: "GPT 5.3 Codex (xHigh)" },
    { id: "gpt-5.3-codex-high", name: "GPT 5.3 Codex (High)" },
    { id: "gpt-5.3-codex-low", name: "GPT 5.3 Codex (Low)" },
    { id: "gpt-5.3-codex-none", name: "GPT 5.3 Codex (None)" },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
    // Mini - medium and high only
    { id: "gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini" },
    { id: "gpt-5.1-codex-mini-high", name: "GPT 5.1 Codex Mini (High)" },
    // Other models
    { id: "gpt-5.2-codex", name: "GPT 5.2 Codex" },
    { id: "gpt-5.2", name: "GPT 5.2" },
    { id: "gpt-5.1-codex-max", name: "GPT 5.1 Codex Max" },
    { id: "gpt-5.1-codex", name: "GPT 5.1 Codex" },
    { id: "gpt-5.1", name: "GPT 5.1" },
    { id: "gpt-5-codex", name: "GPT 5 Codex" },
    { id: "gpt-5-codex-mini", name: "GPT 5 Codex Mini" },
  ],
  gc: [ // Gemini CLI
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
  ],
  qw: [ // Qwen Code
    // { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
    { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
    { id: "qwen3-coder-flash", name: "Qwen3 Coder Flash" },
    { id: "vision-model", name: "Qwen3 Vision Model" },
    { id: "coder-model", name: "Qwen3.5 Coder Model" },
  ],
  if: [ // iFlow AI
    { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
    { id: "qwen3-max", name: "Qwen3 Max" },
    { id: "qwen3-vl-plus", name: "Qwen3 VL Plus" },
    { id: "qwen3-max-preview", name: "Qwen3 Max Preview" },
    { id: "qwen3-235b", name: "Qwen3 235B A22B" },
    { id: "qwen3-235b-a22b-instruct", name: "Qwen3 235B A22B Instruct" },
    { id: "qwen3-235b-a22b-thinking-2507", name: "Qwen3 235B A22B Thinking" },
    { id: "qwen3-32b", name: "Qwen3 32B" },
    { id: "kimi-k2", name: "Kimi K2" },
    { id: "deepseek-v3.2", name: "DeepSeek V3.2 Exp" },
    { id: "deepseek-v3.1", name: "DeepSeek V3.1 Terminus" },
    { id: "deepseek-v3", name: "DeepSeek V3 671B" },
    { id: "deepseek-r1", name: "DeepSeek R1" },
    { id: "glm-4.7", name: "GLM 4.7" },
    { id: "iflow-rome-30ba3b", name: "iFlow ROME" },
  ],
  ag: [ // Antigravity - special case: models call different backends
    { id: "gemini-3.1-pro-high", name: "Gemini 3 Pro High" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3 Pro Low" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
    { id: "gpt-oss-120b-medium", name: "GPT OSS 120B Medium" },
  ],
  gh: [ // GitHub Copilot - OpenAI models
    { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
    { id: "gpt-4", name: "GPT-4" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o mini" },
    { id: "gpt-4.1", name: "GPT-4.1" },
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-mini", name: "GPT-5 Mini" },
    { id: "gpt-5-codex", name: "GPT-5 Codex" },
    { id: "gpt-5.1", name: "GPT-5.1" },
    { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
    { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    // GitHub Copilot - Anthropic models
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "claude-opus-4.1", name: "Claude Opus 4.1" },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
    // GitHub Copilot - Google models
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
  ],
  kr: [ // Kiro AI
    // { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "deepseek-3.2", name: "DeepSeek 3.2" },
    { id: "deepseek-3.1", name: "DeepSeek 3.1" },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
  ],
  cu: [ // Cursor IDE
    { id: "default", name: "Auto (Server Picks)" },
    { id: "claude-4.5-opus-high-thinking", name: "Claude 4.5 Opus High Thinking" },
    { id: "claude-4.5-opus-high", name: "Claude 4.5 Opus High" },
    { id: "claude-4.5-sonnet-thinking", name: "Claude 4.5 Sonnet Thinking" },
    { id: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet" },
    { id: "claude-4.5-haiku", name: "Claude 4.5 Haiku" },
    { id: "claude-4.5-opus", name: "Claude 4.5 Opus" },
    { id: "gpt-5.2-codex", name: "GPT 5.2 Codex" },
    { id: "claude-4.6-opus-max", name: "Claude 4.6 Opus Max" },
    { id: "claude-4.6-sonnet-medium-thinking", name: "Claude 4.6 Sonnet Medium Thinking" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "gpt-5.2", name: "GPT 5.2" },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
  ],
  kmc: [ // Kimi Coding
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "kimi-k2.5-thinking", name: "Kimi K2.5 Thinking" },
    { id: "kimi-latest", name: "Kimi Latest" },
  ],
  kc: [ // KiloCode
    { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "anthropic/claude-opus-4-20250514", name: "Claude Opus 4" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "openai/gpt-4.1", name: "GPT-4.1" },
    { id: "openai/o3", name: "o3" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner" },
  ],
  cl: [ // Cline
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "openai/gpt-5.4", name: "GPT-5.4" },
  ],
  zunef: [ // Zunef - API Key provider
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    { id: "claude-haiku-4-20250514", name: "Claude Haiku 4" },
  ],
};

export function isValidModel(aliasOrId, modelId, passthroughProviders = new Set()) {
  if (passthroughProviders.has(aliasOrId)) return true;
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return false;
  return models.some(m => m.id === modelId);
}

export function findModelName(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return modelId;
  const found = models.find(m => m.id === modelId);
  return found?.name || modelId;
}

export function getModelTargetFormat(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = models.find(m => m.id === modelId);
  return found?.targetFormat || null;
}

// OAuth providers that use short aliases (everything else: alias = id)
const OAUTH_ALIASES = {
  claude: "cc",
  codex: "cx",
  "gemini-cli": "gc",
  qwen: "qw",
  iflow: "if",
  antigravity: "ag",
  github: "gh",
  kiro: "kr",
  cursor: "cu",
  "kimi-coding": "kmc",
  kilocode: "kc",
  cline: "cl",
  vertex: "vertex",
  "vertex-partner": "vertex-partner",
};

// Derived from PROVIDERS — no need to maintain manually
export const PROVIDER_ID_TO_ALIAS = Object.fromEntries(
  Object.keys(PROVIDERS).map(id => [id, OAUTH_ALIASES[id] || id])
);

export function getModelsByProviderId(providerId) {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return PROVIDER_MODELS[alias] || [];
}

export function getProviderModels(providerId) {
  return getModelsByProviderId(providerId);
}

export function getDefaultModel(providerId) {
  const models = getModelsByProviderId(providerId);
  return models.length > 0 ? models[0].id : null;
}