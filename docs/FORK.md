# Fork Notes — Knight1988/9router vs decolua/9router

_Last updated: 2026-05-22_

This repository is a fork of [decolua/9router](https://github.com/decolua/9router). The active branch is `beta`. This document summarizes how it differs from upstream `decolua/master` so contributors don't confuse fork-specific behavior with upstream behavior.

## Snapshot

Comparison baseline: `decolua/master` → `Knight1988/9router` `beta`.

- 142 non-merge commits ahead of upstream
- 120 files changed, +9,520 / -613 lines
- Regenerate with:
  ```bash
  git fetch decolua master
  git log --oneline --no-merges decolua/master..beta
  git diff --shortstat decolua/master...beta
  ```

## At a glance

- Azure DevOps CI/CD pipeline (test → build → deploy) with a real Vitest test suite.
- Smart routing + provider health observability layered on top of upstream's combo system.
- HTTPS support, additional providers (Claudible family, Techopenclaw, DevGo), and various stream/usage hardening.

## What this fork adds

### 1. CI/CD — Azure Pipelines
Three-stage pipeline: Vitest unit tests, Docker build with live API smoke tests, push to Docker Hub + Portainer redeploy on `beta`. Pipeline URL: `https://dev.azure.com/Knight1988/9router/_build`.

Files: `azure-pipelines.yml`, `check-pipeline.sh`.

### 2. Smart routing
Quota-aware combo execution. A scheduler periodically refreshes provider quotas and reorders combo entries so providers with remaining capacity run first. Adds three combo strategies (fallback, round-robin, smart-routing), recursive sub-combo expansion with cycle detection, exponential backoff on retries (1.5s → 60s cap), and abort-signal support so retry loops cancel on client disconnect.

Files: `src/lib/smartRouting/scheduler.js`, `src/lib/smartRouting/quotaCheck.js`, `open-sse/services/combo.js`, `src/app/api/combos/[id]/smart-routing/`.

### 3. Observability
Abnormal-response logger writes structured artifacts (with masked auth) for empty completions, malformed SSE chunks, bad finish reasons, and format mismatches. Provider health is rolled up daily into a `providerHealthDaily` table (success rate, latency, TTFT, rate-limit hits) so dashboards stop scanning live request rows. New Error Log dashboard mirrors the existing Console Log.

Files: `open-sse/utils/abnormalLogger.js`, `src/lib/db/repos/providerHealthRepo.js`, `src/app/(dashboard)/dashboard/error-log/page.js`, `src/app/api/translator/error-logs/`.

### 4. HTTPS support
Separate HTTPS entry point that resolves certs from env vars or `DATA_DIR/ssl`, falls back to HTTP when disabled or certs are missing. Settings UI for cert upload.

Files: `server-https.js`, `src/lib/ssl.js`, `src/app/api/settings/ssl/route.js`.

### 5. New / extended providers
Claudible family (vip-claudible, cn-claudible, minimax-claudible), Techopenclaw, DevGo, and several free-tier providers. Includes Copilot SSE handler hardening (logs malformed chunks, retains stream order so `message_start` is emitted first).

Files: `open-sse/config/providers.js`, `src/shared/constants/providers.js`, `src/mitm/handlers/copilot.js`.

### 6. Usage tracking
Cached-tokens column in request details, dedicated **API Key Usage** tab, **Provider Health** tab with 24h / 7d / 30d / 90d filtering and weighted aggregates.

Files: `src/app/(dashboard)/dashboard/usage/components/ApiKeyUsageTab.js`, `src/app/(dashboard)/dashboard/usage/components/ProviderHealthTab.js`, `src/lib/db/schema.js`, `src/app/api/usage/provider-health/route.js`.

### 7. Testing
Vitest unit suite covering combo fallback / expand / retry-backoff / empty-stream, provider health, OAuth auto-import, Claude header forwarding, and dashboard guards. Wired into pipeline stage 1.

Files: `tests/unit/*.test.js`, `tests/vitest.config.js`.

### 8. Misc hardening
Tailwind/PostCSS config fix so the Docker build keeps Tailwind content scanning, `KEEP_BACKUPS` lowered from 5 → 2, retry on empty completions, fallback user message changed from `continue` to `continue where you left off`, and a `.next` exclusion in the Vitest glob.

## What is unchanged from upstream

- Dashboard layout and routing shell
- OAuth flows for Claude / Codex / Gemini / Qwen / iFlow / Kiro / Cursor / Antigravity
- `db.json` baseline schema (this fork only adds new tables / columns)
- Translator core (request/response format conversion)
- npm package metadata, CLI entry point, and overall architecture described in `docs/ARCHITECTURE.md`

## Keeping this doc fresh

Re-run the snapshot commands above after merging upstream and refresh the bullet list whenever a category changes meaningfully. The categorized format is intentional — avoid expanding into a per-commit table.
