# Fork Notes — Knight1988/9router vs decolua/9router

_Last updated: 2026-06-15 (refreshed after merging upstream v0.4.77)_

This repository is a fork of [decolua/9router](https://github.com/decolua/9router). The active branch is `beta`. This document summarizes how it differs from upstream `decolua/master` so contributors don't confuse fork-specific behavior with upstream behavior.

## Snapshot

Comparison baseline: `decolua/master` → `Knight1988/9router` `beta`.

- 188 non-merge commits ahead of upstream
- 172 files changed, +14,002 / -799 lines
- Regenerate with:
  ```bash
  git fetch decolua master
  git log --oneline --no-merges decolua/master..beta
  git diff --shortstat decolua/master...beta
  ```

## At a glance

- Azure DevOps CI/CD pipeline (test → build → deploy) with a real Vitest test suite.
- Smart routing + provider health observability layered on top of upstream's combo system.
- HTTPS support, additional providers (Claudible family, Techopenclaw, DevGo, Open Claude, Troll LLM), and various stream/usage hardening.
- Upstream v0.4.77 merged: Vercel AI Gateway, MiMo Free provider, SSRF guard on web-fetch, OpenAI-Responses terminal synthesis, real client IP rate-limiting, and Kiro multi-endpoint failover.

## What this fork adds

### 1. CI/CD — Azure Pipelines
Three-stage pipeline: Vitest unit tests, Docker build with live API smoke tests, push to Docker Hub + Portainer redeploy on `beta`. Pipeline URL: `https://dev.azure.com/Knight1988/9router/_build`.

Files: `azure-pipelines.yml`, `check-pipeline.sh`.

### 2. Smart routing
Quota-aware combo execution. A scheduler (auto-started on boot via `instrumentation.js`) periodically refreshes provider quotas and reorders combo entries so providers with remaining capacity run first. Three combo strategies (fallback, round-robin, smart-routing), recursive sub-combo expansion with cycle detection, exponential backoff on retries (1.5s → 60s cap), and abort-signal support so retry loops cancel on client disconnect. A health tracker dynamically demotes providers that return empty completions, bypassing the periodic refresh cycle. Smart routing auto-disables for a combo when all its models lose quota support.

Files: `src/lib/smartRouting/scheduler.js`, `src/lib/smartRouting/quotaCheck.js`, `src/lib/smartRouting/healthTracker.js`, `src/lib/smartRouting/getEffectivePriority.js`, `open-sse/services/combo.js`, `src/app/api/combos/[id]/smart-routing/`.

### 3. Observability
Abnormal-response logger writes structured artifacts (with masked auth) for empty completions, malformed SSE chunks, bad finish reasons, and format mismatches. Provider health is rolled up daily into a `providerHealthDaily` table (success rate, latency, TTFT, rate-limit hits) so dashboards stop scanning live request rows. New Error Log dashboard mirrors the existing Console Log.

Files: `open-sse/utils/abnormalLogger.js`, `src/lib/db/repos/providerHealthRepo.js`, `src/app/(dashboard)/dashboard/error-log/page.js`, `src/app/api/translator/error-logs/`.

### 4. HTTPS support
Separate HTTPS entry point that resolves certs from env vars or `DATA_DIR/ssl`, falls back to HTTP when disabled or certs are missing. Settings UI for cert upload.

Files: `server-https.js`, `src/lib/ssl.js`, `src/app/api/settings/ssl/route.js`.

### 5. New / extended providers
Claudible family (vip-claudible, cn-claudible, minimax-claudible, cc-claudible, claude-claudible, codex-claudible), Techopenclaw, DevGo, Open Claude (`oc`) with username+password quota monitoring, and Troll LLM (`tl`) with bearer-token quota tracking. Includes Copilot SSE handler hardening (logs malformed chunks, retains stream order so `message_start` is emitted first). Provider streaming can be disabled per-provider.

Files: `open-sse/config/providers.js`, `src/shared/constants/providers.js`, `src/mitm/handlers/copilot.js`, `open-sse/services/openClaudeQuota.js`.

### 6. Usage tracking
Cached-tokens column in request details, dedicated **API Key Usage** tab, **Provider Health** tab with 24h / 7d / 30d / 90d filtering and weighted aggregates.

Files: `src/app/(dashboard)/dashboard/usage/components/ApiKeyUsageTab.js`, `src/app/(dashboard)/dashboard/usage/components/ProviderHealthTab.js`, `src/lib/db/schema.js`, `src/app/api/usage/provider-health/route.js`.

### 7. Testing
Vitest unit suite covering combo fallback / expand / retry-backoff / empty-stream / routing, provider health, OAuth auto-import, Claude header forwarding, dashboard guards, DB migration chain / concurrency / benchmarks, translator request normalization, and more. Wired into pipeline stage 1.

Files: `tests/unit/*.test.js`, `tests/vitest.config.js`.

### 8. Same-API header forwarding
When the client and provider share the same API family (Claude↔Claude or OpenAI↔OpenAI), safe client headers are forwarded to the upstream provider. This lets `anthropic-beta` feature flags, `x-stainless-*` telemetry, `openai-version`, `user-agent`, and custom `x-*` headers flow end-to-end without configuration. Hop-by-hop, transport, and auth headers are always blocked; provider-specific headers built by 9router win on any conflict.

Files: `open-sse/utils/clientDetector.js`, `open-sse/handlers/chatCore.js`, `open-sse/executors/base.js`.

### 9. Fetch retry hardening
All bare `fetch()` calls are wrapped in a `fetchWithRetry` utility that adds per-request jitter, configurable backoff, and abort-signal awareness so in-flight retries cancel cleanly on client disconnect.

Files: `open-sse/utils/retry.js`.

### 10. Per-API-key rate limiter
Enforces a 30 req/min cap at the SSE entry point, keyed by API key. Prevents a single key from flooding the proxy.

Files: `src/lib/rateLimiter.js`, `src/sse/utils/rateLimiter.js`.

### 11. Security hardening
Brute-force prevention on the login and password-change endpoints (lock-out after repeated failures). Auth session lifetime extended to 7 days with sliding refresh.

Files: `src/sse/services/auth.js`, `src/app/(dashboard)/dashboard/profile/page.js`.

### 12. Prompt caching and context controls
Per-connection `setCacheKey` toggle activates Anthropic prompt caching for that connection. Global auto-compact context setting lets operators configure a token threshold at which the context compactor fires automatically.

Files: `src/shared/components/EditConnectionModal.js`, `open-sse/utils/contextCompactor.js`, `src/app/api/settings/route.js`.

### 13. Misc hardening
Tailwind/PostCSS config fix so the Docker build keeps Tailwind content scanning, `KEEP_BACKUPS` lowered from 5 → 2, retry on empty completions, fallback user message changed from `continue` to `continue where you left off`, empty stream detection timeout raised to 60s, `message_start` guaranteed to be emitted first in Claude-format streams, 502 returned on empty completion so combos fall through to the next model, timestamps added to error-log and console-log lines, a `.next` exclusion in the Vitest glob, and fetch connect timeout extended to 5 min for long-reasoning providers.

### 14. Upstream v0.4.77 adopted features
Features from upstream v0.4.77 now live in this fork: **Vercel AI Gateway** provider (embeddings, images, credit usage); **MiMo Free** no-auth provider; **SSRF guard** on web-fetch endpoints (`assertPublicUrl`); **OpenAI-Responses terminal synthesis** — synthesize `response.failed` + `[DONE]` when a Responses passthrough stream aborts/stalls before a terminal event; **real client IP rate-limiting** and remote default-password guard; **Kiro multi-endpoint failover** for GenerateAssistantResponse; **combo page** now shows explicit `kind="llm"` combos. Also adopted: `Vitest maxConcurrency: 60` and the `codex-refresh-token` test cleanup fix.

Files: `open-sse/config/providerModels.js`, `src/shared/constants/providers.js`, `open-sse/services/usage.js`, `src/sse/handlers/fetch.js`, `open-sse/utils/stream.js`, `open-sse/handlers/chatCore/streamingHandler.js`, `src/app/(dashboard)/dashboard/combos/page.js`.

## What is unchanged from upstream

- Dashboard layout and routing shell
- OAuth flows for Claude / Codex / Gemini / Qwen / iFlow / Kiro / Cursor / Antigravity
- `db.json` baseline schema (this fork only adds new tables / columns)
- Translator core (request/response format conversion)
- npm package metadata, CLI entry point, and overall architecture described in `docs/ARCHITECTURE.md`

## Keeping this doc fresh

Re-run the snapshot commands above after merging upstream and refresh the bullet list whenever a category changes meaningfully. The categorized format is intentional — avoid expanding into a per-commit table.
