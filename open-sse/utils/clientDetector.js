/**
 * Detect CLI tool identity from request headers/body.
 * Used to determine if a request can be passed through losslessly.
 */

// Map of CLI tool identifiers to provider IDs they are "native" to
const NATIVE_PAIRS = {
  "claude": ["claude", "anthropic"],
  "gemini-cli": ["gemini-cli"],
  "antigravity": ["antigravity"],
  "codex": ["codex"],
};

/**
 * Detect which CLI tool is making the request.
 * Returns one of: "claude" | "gemini-cli" | "antigravity" | "codex" | null
 * @param {object} headers - Lowercase header key/value object
 * @param {object} body    - Parsed request body
 */
export function detectClientTool(headers = {}, body = {}) {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const xApp = (headers["x-app"] || "").toLowerCase();
  const openaiIntent = (headers["openai-intent"] || "").toLowerCase();
  const initiator = (headers["x-initiator"] || headers["X-Initiator"] || "").toLowerCase();

  // Antigravity: detected via body field (not header)
  if (body.userAgent === "antigravity") return "antigravity";

  // GitHub Copilot / OAI compatible extension using Copilot chat headers
  if (ua.includes("githubcopilotchat") || openaiIntent === "conversation-panel" || initiator === "user") {
    return "github-copilot";
  }

  // Claude Code / Claude CLI
  if (ua.includes("claude-cli") || ua.includes("claude-code") || xApp === "cli") return "claude";

  // Gemini CLI
  if (ua.includes("gemini-cli")) return "gemini-cli";

  // Codex CLI
  if (ua.includes("codex-cli")) return "codex";

  // DeepSeek TUI
  if (ua.includes("deepseek-tui")) return "deepseek-tui";

  return null;
}

/**
 * Check if this CLI tool + provider pair should be passed through losslessly.
 * @param {string|null} clientTool - Result of detectClientTool()
 * @param {string} provider        - Provider ID (e.g. "claude", "gemini-cli")
 */
export function isNativePassthrough(clientTool, provider) {
  if (!clientTool) return false;
  const nativeProviders = NATIVE_PAIRS[clientTool];
  if (!nativeProviders) return false;
  // Support anthropic-compatible-* variants
  const normalizedProvider = provider.startsWith("anthropic-compatible")
    ? "anthropic"
    : provider;
  return nativeProviders.includes(normalizedProvider);
}

// Format families for same-API header forwarding
const CLAUDE_FORMATS = new Set(["claude"]);
const OPENAI_FORMATS = new Set(["openai", "openai-responses", "openai-response"]);

/**
 * Check if the client and provider speak the same API family.
 * When true, client headers should be forwarded to the provider.
 * @param {string} sourceFormat - Detected client request format
 * @param {string} targetFormat - Provider target format
 */
export function isSameApiFamily(sourceFormat, targetFormat) {
  if (!sourceFormat || !targetFormat) return false;
  if (CLAUDE_FORMATS.has(sourceFormat) && CLAUDE_FORMATS.has(targetFormat)) return true;
  if (OPENAI_FORMATS.has(sourceFormat) && OPENAI_FORMATS.has(targetFormat)) return true;
  return false;
}

/**
 * Headers that must never be forwarded to the upstream provider.
 * Covers: hop-by-hop transport headers, headers 9router overrides, and internal headers.
 */
export const HEADER_FORWARD_BLOCKLIST = new Set([
  "host", "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-connection", "content-type", "content-length",
  "authorization", "x-api-key", "x-request-source",
  // 9router controls response decoding; client accept-encoding may advertise
  // zstd (which undici won't decompress) and must never reach the upstream.
  "accept-encoding",
]);

/**
 * Return a filtered copy of client headers safe to forward to the provider.
 * Strips hop-by-hop, transport, and auth headers that 9router manages itself.
 * @param {object} clientHeaders - Raw client request headers (lowercase keys)
 */
export function getForwardableClientHeaders(clientHeaders) {
  if (!clientHeaders || typeof clientHeaders !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!HEADER_FORWARD_BLOCKLIST.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Merge forwarded client headers under provider headers, case-insensitively.
 * Client headers arrive lowercase (request.headers.entries()); provider headers are
 * mixed-case. A naive object spread leaves duplicate-cased keys (e.g. "accept-encoding"
 * + "Accept-Encoding") that undici emits as two header lines on the wire, which
 * Cloudflare-fronted upstreams reject with 502. Provider headers always win on any
 * case-insensitive collision. Non-colliding client headers (e.g. "user-agent") pass through.
 * @param {object} clientHeaders - Forwarded client headers (lowercase keys, pre-filtered)
 * @param {object} providerHeaders - Provider-specific headers built by buildHeaders()
 * @returns {object} Merged headers with no duplicate-cased keys
 */
export function mergeForwardedHeaders(clientHeaders, providerHeaders) {
  if (!clientHeaders || Object.keys(clientHeaders).length === 0) return providerHeaders;
  const providerLcKeys = new Set(Object.keys(providerHeaders).map((k) => k.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (!providerLcKeys.has(k.toLowerCase())) out[k] = v;
  }
  return Object.assign(out, providerHeaders);
}
