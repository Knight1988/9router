// Single source: build PROVIDERS + PROVIDER_MODELS from registry/{id}.js (transport + models co-located).
import REGISTRY from "./registry/index.js";
import { PROVIDER_DEFAULTS } from "./schema.js";
import { normalizeModel } from "./models/schema.js";
import { buildTtsProviderModels } from "../config/ttsModels.js";

// oauth block is canonical for these fields; inject into transport so executors reading
// this.config.{clientId,clientSecret,tokenUrl} keep working without duplicating in transport
const OAUTH_INJECT_FIELDS = ["clientId", "clientSecret", "tokenUrl"];

// transport: re-apply shared default (format:"openai") + inject oauth-canonical fields
function buildTransport(transport, oauth) {
  const t = { ...transport };
  if (!t.format) t.format = PROVIDER_DEFAULTS.format;
  if (oauth) {
    for (const f of OAUTH_INJECT_FIELDS) {
      if (t[f] === undefined && oauth[f] !== undefined) t[f] = oauth[f];
    }
  }
  return t;
}

const MEDIA_KEYS = new Set([
  "serviceKinds", "ttsConfig", "sttConfig", "embeddingConfig",
  "imageConfig", "imageToTextConfig", "videoConfig", "musicConfig",
  "searchViaChat", "searchConfig", "fetchConfig",
  "modelsFetcher", "mediaPriority", "hiddenKinds",
]);

export const PROVIDERS = {};
export const PROVIDER_MODELS = {};
export const PROVIDER_OAUTH = {};
export const PROVIDER_MEDIA = {};
for (const entry of REGISTRY) {
  if (entry.transport) {
    PROVIDERS[entry.id] = buildTransport(entry.transport, entry.oauth);
    if (entry.transports) PROVIDERS[entry.id].transports = entry.transports;
  }
  if (entry.models !== undefined) PROVIDER_MODELS[entry.alias || entry.id] = entry.models.map(normalizeModel);
  if (entry.oauth) PROVIDER_OAUTH[entry.id] = entry.oauth;
  // Build PROVIDER_MEDIA from top-level fields (post-migration) + legacy entry.media
  const mediaFields = {};
  for (const k of MEDIA_KEYS) {
    if (entry[k] !== undefined) mediaFields[k] = entry[k];
  }
  if (entry.media) Object.assign(mediaFields, entry.media);
  if (Object.keys(mediaFields).length) PROVIDER_MEDIA[entry.id] = mediaFields;
}

// TTS model/voice tables keyed by special names (openai-tts-models, ...), not provider ids
Object.assign(PROVIDER_MODELS, buildTtsProviderModels());

// Beta-only provider transports not yet in the registry — supplement PROVIDERS directly.
// Format/URL taken from the pre-registry providers.js (open-sse/config/providers.js@beta).
const CLAUDE_API_HEADERS = {
  "Anthropic-Version": "2023-06-01",
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
};
const CLAUDIBLE_HEADERS = {
  ...CLAUDE_API_HEADERS,
  "User-Agent": "claude-cli/2.1.92 (external, sdk-cli)",
  "X-App": "cli",
};
Object.assign(PROVIDERS, {
  techopenclaw:         { format: "claude",           baseUrl: "https://api.techopenclaw.com/v1/messages",             headers: { ...CLAUDE_API_HEADERS }, stallTimeoutMs: 300_000 },
  "vip-claudible":     { format: "claude",           baseUrl: "https://vip.claudible.io/v1/messages",                 headers: { ...CLAUDIBLE_HEADERS },  stallTimeoutMs: 300_000 },
  "cc-claudible":      { format: "claude",           baseUrl: "https://cc.claudible.io/v1/messages",                  headers: { ...CLAUDIBLE_HEADERS },  stallTimeoutMs: 300_000 },
  "cn-claudible":      { format: "openai",           baseUrl: "https://cn.claudible.io/v1/chat/completions",                                              stallTimeoutMs: 300_000 },
  "minimax-claudible": { format: "claude",           baseUrl: "https://minimax.claudible.io/v1/messages",             headers: { ...CLAUDIBLE_HEADERS },  stallTimeoutMs: 300_000 },
  "claude-claudible":  { format: "claude",           baseUrl: "https://claude.claudible.io/v1/messages",              headers: { ...CLAUDIBLE_HEADERS },  stallTimeoutMs: 300_000 },
  "codex-claudible":   { format: "openai-responses", baseUrl: "https://codex.claudible.io/v1/responses",                                                  stallTimeoutMs: 300_000 },
  "open-claude":       { format: "openai",           baseUrl: "https://open-claude.com/v1/chat/completions",          retry: { 503: 3 },                  stallTimeoutMs: 300_000 },
  "troll-llm":         { format: "openai",           baseUrl: "https://chat.trollllm.xyz/v1/chat/completions",                                            stallTimeoutMs: 300_000 },
  devgo:               { format: "openai",           baseUrl: "https://9router.tools.devgovietnam.io.vn/v2/chat/completions", retry: { 503: 3, 429: 2 },  stallTimeoutMs: 300_000 },
});

// Beta-only providers not yet in the registry — supplement model lists directly
Object.assign(PROVIDER_MODELS, {
  techopenclaw: [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.5", name: "GPT-5.5" },
  ],
  "vip-claudible": [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (2025-10-01)" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claudible", name: "Claudible" },
  ],
  "cc-claudible": [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  ],
  "cn-claudible": [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "qwen3.6-plus", name: "Qwen 3.6 Plus" },
  ],
  "minimax-claudible": [
    { id: "MiniMax-CodingPlan", name: "MiniMax CodingPlan" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" },
  ],
  "claude-claudible": [
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.5", name: "GPT 5.5" },
  ],
  "codex-claudible": [
    { id: "codex-auto-review", name: "Codex Auto Review" },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.5", name: "GPT 5.5" },
  ],
  "open-claude": [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  ],
  devgo: [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  ],
});
