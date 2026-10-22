export default {
  id: "infinityrouter",
  alias: "infinityrouter",
  category: "apikey",
  display: {
    name: "InfinityRouter",
    icon: "all_inclusive",
    color: "#6366F1",
    textIcon: "IR",
    website: "https://infinityrouter.dev",
    notice: {
      text: "Subscription AI gateway with Anthropic-compatible requests and model discovery.",
      apiKeyUrl: "https://infinityrouter.dev",
    },
  },
  serviceKinds: ["llm"],
  passthroughModels: true,
  transport: {
    format: "claude",
    baseUrl: "https://infinityrouter.dev/v1/messages",
    validateUrl: "https://infinityrouter.dev/v1/models",
    stallTimeoutMs: 300_000,
  },
  // Seed only models advertised on the provider website; discovery supplies account-specific models.
  models: [
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash (1017)" },
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "gpt-6-astra", name: "GPT 6 Astra" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  ],
};
