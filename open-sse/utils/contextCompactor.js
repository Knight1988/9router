import { estimateInputTokens } from "./usageTracking.js";
import { detectFormatByEndpoint, FORMATS } from "../translator/formats.js";

const SUMMARY_PROMPT = `Output exactly this Markdown structure and keep the section order unchanged:
---
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]
---

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

/**
 * Extract the last N user-turn boundaries from a messages array.
 * Returns the index of the first message that belongs in the tail.
 * Returns 0 if the entire history should be kept (nothing to compact).
 */
function findTailStart(messages, tailTurns) {
  if (!tailTurns || tailTurns <= 0) return 0;
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role === "user") {
      turns++;
      if (turns >= tailTurns) {
        // Keep everything from this user message onward
        return i;
      }
    }
  }
  // Not enough turns to split — keep everything
  return 0;
}

/**
 * Serialize head messages into a readable text block for summarization.
 */
function serializeHead(messages) {
  return messages.map((m) => {
    const role = m.role.toUpperCase();
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n")
          : JSON.stringify(m.content);
    return `[${role}]\n${content}`;
  }).join("\n\n");
}

/**
 * Call the LLM to summarize a block of conversation history.
 * Uses handleChat internally with a synthetic request.
 * Returns the summary string or null on failure.
 */
async function summarizeHead(headText, model, endpoint) {
  // Lazy import to avoid circular dependency (handleChat imports this module).
  const { handleChat } = await import("@/sse/handlers/chat.js");

  const summaryBody = {
    model,
    messages: [
      {
        role: "user",
        content:
          "Below is a conversation history. Summarize it using the exact Markdown structure specified.\n\n" +
          "<conversation-history>\n" +
          headText +
          "\n</conversation-history>\n\n" +
          SUMMARY_PROMPT,
      },
    ],
    stream: false,
    max_tokens: 2048,
    // Internal flag: skip auto-compact re-entry and observability noise
    _isInternalCompaction: true,
  };

  // Use /v1/chat/completions as synthetic endpoint so it routes via standard OpenAI format
  const syntheticUrl = new URL(endpoint);
  syntheticUrl.pathname = "/v1/chat/completions";

  const syntheticRequest = new Request(syntheticUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(summaryBody),
  });

  const response = await handleChat(syntheticRequest);
  if (!response || !response.body) return null;

  // Read the full response body (non-streaming JSON)
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json?.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

/**
 * Attempt to compact body.messages / body.input if estimated tokens exceed threshold.
 * Mutates body in-place. No-ops silently on failure.
 */
export async function compactBodyIfNeeded({ body, endpoint, settings, log }) {
  const threshold = settings.autoCompactTokenThreshold ?? 150000;
  const tailTurns = settings.autoCompactTailTurns ?? 2;
  const summarizerModel = settings.autoCompactSummarizerModel?.trim() || body.model;

  const estimated = estimateInputTokens(body);
  if (estimated <= threshold) return;

  const format = detectFormatByEndpoint(new URL(endpoint).pathname, body) || FORMATS.OPENAI;

  // Normalise message array and system prompt depending on format
  let messages; // mutable ref into body
  let systemMsgs = [];

  if (format === FORMATS.OPENAI_RESPONSES) {
    // body.input is the message array for Responses API
    if (!Array.isArray(body.input) || body.input.length < 3) return;
    messages = body.input;
  } else if (format === FORMATS.CLAUDE) {
    if (!Array.isArray(body.messages) || body.messages.length < 3) return;
    messages = body.messages;
    // system is a separate field in Claude format; keep it untouched
  } else {
    // openai chat completions
    if (!Array.isArray(body.messages) || body.messages.length < 3) return;
    // Separate system messages (keep them outside the compaction window)
    systemMsgs = messages = body.messages; // will refine below
    systemMsgs = body.messages.filter((m) => m.role === "system");
    messages = body.messages.filter((m) => m.role !== "system");
    if (messages.length < 3) return;
  }

  const tailStart = findTailStart(messages, tailTurns);
  // Need at least one message in head to compact
  if (tailStart <= 0) return;

  const head = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);

  if (log) {
    log.info("COMPACT", `Auto-compact triggered: ~${estimated} tokens > ${threshold} threshold. Summarizing ${head.length} messages, keeping ${tail.length} tail.`);
  }

  const headText = serializeHead(head);
  const summary = await summarizeHead(headText, summarizerModel, endpoint);
  if (!summary) {
    if (log) log.warn("COMPACT", "Summarization returned empty result; proceeding with original context.");
    return;
  }

  if (log) log.info("COMPACT", "Summarization complete; replacing head with summary message.");

  // Rebuild messages with summary injected
  if (format === FORMATS.OPENAI_RESPONSES) {
    body.input = [
      { role: "system", content: "[Compacted summary of prior conversation]\n" + summary },
      ...tail,
    ];
  } else if (format === FORMATS.CLAUDE) {
    // Claude requires alternating user/assistant turns; inject summary into system field
    const existingSystem = body.system || "";
    const systemPrefix = "[Compacted summary of prior conversation]\n" + summary;
    body.system = existingSystem
      ? systemPrefix + "\n\n" + existingSystem
      : systemPrefix;
    body.messages = tail;
  } else {
    // OpenAI chat: system messages first, then summary, then tail
    body.messages = [
      ...systemMsgs,
      { role: "system", content: "[Compacted summary of prior conversation]\n" + summary },
      ...tail,
    ];
  }
}
