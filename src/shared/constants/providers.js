// Provider definitions
import REGISTRY from "open-sse/providers/registry/index.js";
import { RISK_NOTICE } from "@/shared/constants/providersDisplay";

const MEDIA_ENTRY_KEYS = [
  "serviceKinds", "ttsConfig", "sttConfig", "embeddingConfig",
  "imageConfig", "imageToTextConfig", "videoConfig", "musicConfig",
  "searchViaChat", "searchConfig", "fetchConfig",
  "modelsFetcher", "mediaPriority", "hiddenKinds",
];

// Build provider UI object from registry entry
function buildProviderEntry(r) {
  const mediaFields = {};
  if (r.media) Object.assign(mediaFields, r.media);
  for (const k of MEDIA_ENTRY_KEYS) {
    if (r[k] !== undefined) mediaFields[k] = r[k];
  }
  const display = { ...(r.display || {}) };
  if (display.deprecationNotice === "RISK_NOTICE") display.deprecationNotice = RISK_NOTICE;
  return {
    ...display,
    id: r.id,
    alias: r.uiAlias || r.alias,
    ...(r.hidden ? { hidden: true } : {}),
    ...mediaFields,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
    ...(r.hasFree ? { hasFree: true } : {}),
    ...(r.thinkingConfig ? { thinkingConfig: r.thinkingConfig } : {}),
    ...(r.regions ? { regions: r.regions, defaultRegion: r.defaultRegion } : {}),
    ...(r.hasProviderSpecificData ? { hasProviderSpecificData: true } : {}),
    ...(r.noAuth ? { noAuth: true } : {}),
    ...(r.passthroughModels ? { passthroughModels: true } : {}),
    ...(r.hasOAuth ? { hasOAuth: true } : {}),
    ...(r.authModes ? { authModes: r.authModes } : {}),
    ...(r.authType ? { authType: r.authType } : {}),
    ...(r.authHint ? { authHint: r.authHint } : {}),
  };
}

const byCategory = (cat) => Object.fromEntries(
  REGISTRY.filter(r => r.category === cat).map(r => [r.id, buildProviderEntry(r)])
);

export const FREE_PROVIDERS = byCategory("free");
export const FREE_TIER_PROVIDERS = byCategory("freeTier");

// Thinking config definitions
// options: list of selectable modes ("auto" = no override from server)
// defaultMode: fallback when user hasn't configured
// extended: claude-style thinking (thinking.type + budget_tokens) — used by most providers
// effort: openai-style reasoning_effort — only openai + codex
export const THINKING_CONFIG = {
  extended: {
    options: ["auto", "on", "off"],
    defaultMode: "auto",
    defaultBudgetTokens: 10000
  },
  effort: {
    options: ["auto", "none", "low", "medium", "high"],
    defaultMode: "auto"
  }
};

export const OAUTH_PROVIDERS = byCategory("oauth");
export const APIKEY_PROVIDERS = byCategory("apikey");

// Web Cookie Providers (use browser session cookie instead of API key)
export const WEB_COOKIE_PROVIDERS = byCategory("webCookie");

// Media provider kinds — each kind maps to a route and endpoint config
export const MEDIA_PROVIDER_KINDS = [
  { id: "embedding",   label: "Embedding",      icon: "data_array",        endpoint: { method: "POST", path: "/v1/embeddings" } },
  { id: "image",       label: "Text to Image",  icon: "brush",             endpoint: { method: "POST", path: "/v1/images/generations" } },
  { id: "imageToText", label: "Image to Text",  icon: "image_search",      endpoint: { method: "POST", path: "/v1/images/understanding" } },
  { id: "tts",         label: "Text To Speech", icon: "record_voice_over", endpoint: { method: "POST", path: "/v1/audio/speech" } },
  { id: "stt",         label: "Speech To Text", icon: "mic",               endpoint: { method: "POST", path: "/v1/audio/transcriptions" } },
  { id: "webSearch",   label: "Web Search",     icon: "travel_explore",    endpoint: { method: "POST", path: "/v1/search" } },
  { id: "webFetch",    label: "Web Fetch",      icon: "language",          endpoint: { method: "POST", path: "/v1/web/fetch" } },
  { id: "video",       label: "Video",          icon: "movie",             endpoint: { method: "POST", path: "/v1/video/generations" } },
  { id: "music",       label: "Music",          icon: "music_note",        endpoint: { method: "POST", path: "/v1/audio/music" } },
];

export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
export const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";
export const CUSTOM_EMBEDDING_PREFIX = "custom-embedding-";

export function isOpenAICompatibleProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(OPENAI_COMPATIBLE_PREFIX);
}

export function isAnthropicCompatibleProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
}

export function isCustomEmbeddingProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(CUSTOM_EMBEDDING_PREFIX);
}

// Beta-only providers (not yet in open-sse registry — defined inline until ported)
const BETA_PROVIDERS = {
  techopenclaw: { id: "techopenclaw", alias: "techopenclaw", name: "Techopenclaw", icon: "smart_toy", color: "#D97757", textIcon: "TOC", website: "https://techopenclaw.com", notice: { text: "Vietnamese AI gateway for Claude, GPT, and Gemini. One API key, multiple models.", apiKeyUrl: "https://techopenclaw.com/dashboard" }, serviceKinds: ["llm"] },
  "vip-claudible": { id: "vip-claudible", alias: "vip-claudible", name: "VIP Claudible", icon: "smart_toy", color: "#D97757", textIcon: "VIP", website: "https://vip.claudible.io", notice: { text: "Cheap Claude Code gateway. Models: claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7, claudible.", apiKeyUrl: "https://claudible.io/dashboard" }, passthroughModels: true, modelsFetcher: { url: "https://claudible.io/api/model-hub", type: "claudible-endpoint", endpointId: "ae7d7a14" }, serviceKinds: ["llm"] },
  "cc-claudible": { id: "cc-claudible", alias: "cc-claudible", name: "CC Claudible", icon: "smart_toy", color: "#D97757", textIcon: "CC", website: "https://cc.claudible.io", notice: { text: "Claude Code promotion gateway. Models: claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7.", apiKeyUrl: "https://claudible.io/dashboard" }, passthroughModels: true, modelsFetcher: { url: "https://claudible.io/api/model-hub", type: "claudible-endpoint", endpointId: "42d4a8aa" }, serviceKinds: ["llm"] },
  "cn-claudible": { id: "cn-claudible", alias: "cn-claudible", name: "Claudible China", icon: "smart_toy", color: "#DC2626", textIcon: "CN", website: "https://cn.claudible.io", notice: { text: "Cheap Chinese models for production. DeepSeek, GLM, Kimi, Qwen.", apiKeyUrl: "https://claudible.io/dashboard" }, passthroughModels: true, modelsFetcher: { url: "https://claudible.io/api/model-hub", type: "claudible-endpoint", endpointId: "b8d17fbe" }, serviceKinds: ["llm"] },
  "minimax-claudible": { id: "minimax-claudible", alias: "minimax-claudible", name: "MiniMax Claudible", icon: "memory", color: "#7C3AED", textIcon: "MX", website: "https://minimax.claudible.io", notice: { text: "MiniMax gateway for OpenClaw, 0.15 credit/req. Models: MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-CodingPlan.", apiKeyUrl: "https://claudible.io/dashboard" }, passthroughModels: true, modelsFetcher: { url: "https://claudible.io/api/model-hub", type: "claudible-endpoint", endpointId: "f5936314" }, serviceKinds: ["llm"] },
  "claude-claudible": { id: "claude-claudible", alias: "claude-claudible", name: "Claude Claudible", icon: "smart_toy", color: "#D97757", textIcon: "CL", website: "https://claude.claudible.io", notice: { text: "Claude Subscription + GPT gateway. Models: gpt-5.4, gpt-5.4-mini, gpt-5.5.", apiKeyUrl: "https://claudible.io/dashboard" }, passthroughModels: true, modelsFetcher: { url: "https://claudible.io/api/model-hub", type: "claudible-endpoint", endpointId: "5046fcac" }, serviceKinds: ["llm"] },
  "codex-claudible": { id: "codex-claudible", alias: "codex-claudible", name: "Codex Claudible", icon: "smart_toy", color: "#10A37F", textIcon: "CX", website: "https://codex.claudible.io", notice: { text: "Codex gateway for GPT and code review models. Models: codex-auto-review, gpt-5.3-codex, gpt-5.4, gpt-5.4-mini, gpt-5.5.", apiKeyUrl: "https://claudible.io/dashboard" }, passthroughModels: true, modelsFetcher: { url: "https://claudible.io/api/model-hub", type: "claudible-endpoint", endpointId: "183b1811" }, serviceKinds: ["llm"] },
  "open-claude": { id: "open-claude", alias: "open-claude", name: "Open Claude", icon: "smart_toy", color: "#D97757", textIcon: "OC", svgIcon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path></svg>', website: "https://open-claude.com", notice: { text: "OpenAI-compatible Claude gateway with usage dashboard and budget tracking.", apiKeyUrl: "https://open-claude.com/keys" } },
  devgo: { id: "devgo", alias: "devgo", name: "DevGoVN", icon: "hub", color: "#0F766E", textIcon: "DG", website: "https://9router.tools.devgovietnam.io.vn", notice: { apiKeyUrl: "https://9router.tools.devgovietnam.io.vn" } },
};

// Merge beta-only providers into APIKEY_PROVIDERS (they all use API keys)
Object.assign(APIKEY_PROVIDERS, BETA_PROVIDERS);

// All providers (combined)
export const AI_PROVIDERS = { ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...OAUTH_PROVIDERS, ...APIKEY_PROVIDERS, ...WEB_COOKIE_PROVIDERS };

// Auth methods
export const AUTH_METHODS = {
  oauth: { id: "oauth" },
  apikey: { id: "apikey" },
  cookie: { id: "cookie" },
};

// Helper: Get provider by alias
export function getProviderByAlias(alias) {
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (provider.alias === alias || provider.id === alias) {
      return provider;
    }
  }
  return null;
}

// Helper: Get provider ID from alias
export function resolveProviderId(aliasOrId) {
  const provider = getProviderByAlias(aliasOrId);
  return provider?.id || aliasOrId;
}

// Helper: Get alias from provider ID
export function getProviderAlias(providerId) {
  const provider = AI_PROVIDERS[providerId];
  return provider?.alias || providerId;
}

// Alias to ID mapping (for quick lookup)
export const ALIAS_TO_ID = Object.values(AI_PROVIDERS).reduce((acc, p) => {
  acc[p.alias] = p.id;
  return acc;
}, {});

// ID to Alias mapping
export const ID_TO_ALIAS = Object.values(AI_PROVIDERS).reduce((acc, p) => {
  acc[p.id] = p.alias;
  return acc;
}, {});

// Helper: Get providers by service kind (e.g. "tts", "embedding", "image")
// Providers without serviceKinds default to ["llm"]
export function getProvidersByKind(kind) {
  return Object.values(AI_PROVIDERS)
    .filter((p) => {
      const kinds = p.serviceKinds ?? ["llm"];
      if (!kinds.includes(kind)) return false;
      if (p.hidden) return false;
      if (p.hiddenKinds?.includes(kind)) return false;
      return true;
    })
    .sort((a, b) => (a.priority ?? a.mediaPriority ?? 999) - (b.priority ?? b.mediaPriority ?? 999));
}

// Derive từ registry features flags
// Beta-only providers (not in registry) that support usage tracking are appended manually.
const BETA_USAGE_PROVIDERS = [
  "techopenclaw", "vip-claudible", "cc-claudible", "cn-claudible",
  "minimax-claudible", "claude-claudible", "codex-claudible", "open-claude", "devgo",
];

export const USAGE_SUPPORTED_PROVIDERS = [
  ...REGISTRY.filter(r => r.features?.usage).map(r => r.id),
  ...BETA_USAGE_PROVIDERS,
];

export const USAGE_APIKEY_PROVIDERS = [
  ...REGISTRY.filter(r => r.features?.usageApikey).map(r => r.id),
  ...BETA_USAGE_PROVIDERS,
];
