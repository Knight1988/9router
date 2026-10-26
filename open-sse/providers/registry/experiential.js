export default {
  id: "experiential",
  alias: "experiential",
  category: "apikey",
  display: {
    name: "Experiential Labs",
    icon: "science",
    color: "#6366F1",
    textIcon: "EL",
    website: "https://platform.experientiallabs.ai",
    notice: {
      text: "OpenAI-compatible gateway. Create an API key in Settings → API Keys.",
      apiKeyUrl: "https://platform.experientiallabs.ai/docs/quickstart",
    },
  },
  serviceKinds: ["llm"],
  passthroughModels: true,
  transport: {
    format: "openai",
    baseUrl: "https://api.experientiallabs.ai/v1/chat/completions",
    validateUrl: "https://api.experientiallabs.ai/v1/models",
  },
  models: [
    { id: "qwen3.8-27b", name: "Qwen3.8 27B" },
  ],
};
