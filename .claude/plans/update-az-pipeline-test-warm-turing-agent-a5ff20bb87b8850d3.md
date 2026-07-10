# Azure DevOps Pipeline & Test Infrastructure Analysis

## 1. Pipeline Configuration Files Found

### Primary Pipeline: `azure-pipelines.yml` (root)
This is the **main CI/CD pipeline** for the 9router project, hosted on Azure DevOps at `https://dev.azure.com/Knight1988`, project `9router`, pipeline ID `15`.

### GitHub Actions (supplementary, not Azure DevOps):
- `.github/workflows/docker-publish.yml` — Builds & pushes Docker images to GHCR + Docker Hub on `v*` tags (multi-arch: amd64/arm64). **No tests.**
- `.github/workflows/gitbook-pages.yml` — Deploys GitBook documentation to GitHub Pages. **No tests.**

---

## 2. Full Azure Pipeline Structure (`azure-pipelines.yml`)

The pipeline has **4 stages** that run sequentially:

### Stage 1: `Test` → Job `UnitTests` — "Run Unit Tests"
- **Pool:** `Ubuntu` (self-hosted)
- **Steps:**
  1. Checkout source
  2. Run inline script that:
     - Sources NVM and sets up Node.js
     - `npm install` (root project)
     - `cd tests && npm install && npm test` (runs Vitest unit tests)
- **Test framework:** Vitest v4, configured via `tests/vitest.config.js`
- **What it tests:** ~120+ pure unit tests in `tests/unit/` and `tests/translator/` covering:
  - Translator format conversion (OpenAI ↔ Claude ↔ Gemini etc.)
  - Model routing, lock isolation, provider health
  - Embeddings, TTS, STT, image generation routing
  - Bug regression tests (Claude Code, Codex CLI, Kiro, Gemini, etc.)
  - Snapshot tests for golden request/response formats

### Stage 1: `Test` → Job `Test` — "Build Docker and Run Tests" (depends on UnitTests)
- **Pool:** `Ubuntu` (self-hosted)
- **Steps:**
  1. Checkout source
  2. Run inline script (the **integration/smoke test**) that:
     - `docker compose down && docker compose up --build -d` — builds and starts the full app
     - Polls `https://localhost:20129/v1/models` for up to 60 seconds (30 × 2s) until server is ready
     - **Tests two models: `planning` and `coding`** — these are virtual/alias model names the router maps to real providers
     - For each model, sends a POST to the **Anthropic Messages API** (`/v1/messages`) with:
       ```json
       {"model":"<planning|coding>","messages":[{"role":"user","content":"say hi"}],"max_tokens":50}
       ```
     - Uses `x-api-key: $(TEST_API_KEY)` (Azure DevOps pipeline variable) and `anthropic-version: 2023-06-01` headers
     - Has **retry logic**: up to 3 attempts per model, 10s delay between retries
     - **Skip logic**: if response contains "no eligible accounts", treats as SKIP (provider not configured on runner)
     - **Response parsing**: tries SSE streaming format first (`content_block_delta` events), falls back to non-streaming JSON
     - Reports PASS/FAIL counts; exits 1 if any FAIL

### Stage 2: `Build` — "Build and Push Docker Image" (depends on Test)
- **Condition:** Only runs on `latest` or `beta` branches
- Builds `knight1988/9router:<branch>` and pushes to Docker Hub

### Stage 3: `Deploy` — "Redeploy Dockge" (depends on Build)
- **Condition:** Only runs on `beta` branch
- Calls Dockge API to trigger stack update (pull + redeploy)
- Uses `$(DOCKGE_API_TOKEN)` pipeline variable
- Has retry logic (3 attempts, 10s delay)

### Triggers
- Branches: `latest` and `beta`
- Pool: Self-hosted `Ubuntu` agent

### Pipeline Variables
- `IMAGE_NAME`: `knight1988/9router`
- `DOCKER_TAG`: `$(Build.SourceBranchName)`
- **Secrets (referenced but stored in Azure DevOps):**
  - `$(TEST_API_KEY)` — used for integration tests
  - `$(DOCKGE_API_TOKEN)` — used for deployment

---

## 3. How Tests Are Structured — Especially Model Testing

### A. Unit Tests (Stage 1, Job 1)
- **Location:** `tests/unit/` (~97 test files) + `tests/translator/` (~15 test files)
- **Config:** `tests/vitest.config.js`
  - Environment: Node.js
  - Includes: `**/*.test.js`
  - Excludes: `node_modules`, `.next`, `.claude`, `dist`, `embeddings.cloud.test.js`
  - Max concurrency: 60
  - Hook timeout: 60s (for DB-heavy tests)
  - Path aliases: `open-sse/` → `../open-sse`, `@/` → `../src`
- **Run command:** `vitest run --reporter=verbose`
- **Notable test files related to models:**
  - `model-lock-isolation.test.js` — Tests per-model lock keying (prevents cross-model lock contamination)
  - `model-test-routing.test.js` — Tests routing of model test requests to correct API endpoints (images, embeddings, STT)
  - `provider-test-models-routing.test.js` — Tests provider-specific model test routing
  - `claude-json-to-sse.test.js` — Tests format conversion; specifically documents a bug where the `planning` model returned raw Anthropic SSE to OpenAI clients
  - `coverage-all-models.test.js` — Data-driven test that exercises translation for **every model** in PROVIDER_MODELS
- **Baseline/regression system:** `tests/__baseline__/` contains:
  - `baseline-results.json` / `current.json` — Test result snapshots
  - `known-fails.txt` — Known failing tests
  - `verify-no-regression.mjs` — Gates against pass→fail regressions

### B. Integration/Smoke Tests (Stage 1, Job 2 — in pipeline YAML)
- **Inline in `azure-pipelines.yml`** (not a separate script file)
- Tests the **Anthropic-format API** (`/v1/messages`) with two model aliases:
  - `planning` — a virtual model alias
  - `coding` — a virtual model alias
- These are the router's custom model names that map to actual LLM providers behind the scenes
- Uses the Anthropic Messages API format (not OpenAI format)
- Tests basic "say hi" completion — verifies end-to-end routing works

### C. Local Test Script (`test.sh`)
- A standalone bash script for local testing (NOT invoked by the pipeline)
- Similar structure but tests via **OpenAI format** (`/v1/chat/completions`) instead of Anthropic format
- Tests both `coding` and `planning` models
- Additionally tests **streaming tool calls** (get_weather function) for each model
- Uses a hardcoded Bearer token instead of pipeline variable
- Includes 5s delays between tests for "model locks to expire"

---

## 4. Scripts Referenced by the Pipeline

### Directly invoked by pipeline:
- **None as external scripts** — all test logic is inline in `azure-pipelines.yml`

### Related scripts (not called by pipeline):
| Script | Purpose |
|--------|---------|
| `test.sh` | Local smoke test (OpenAI format, tool calls, hardcoded auth) |
| `check-pipeline.sh` | Checks latest Azure DevOps pipeline run status via `az` CLI |
| `publish.sh` | Manual Docker build + push helper |

### Docker infrastructure used by tests:
- `docker-compose.yml` — Defines the app service (build from Dockerfile, ports 20128/20129, env vars)
- `Dockerfile` — Multi-stage build: Node 22 Alpine, Next.js app with custom HTTPS server

---

## 5. Key Observations

1. **"coding" and "planning" are virtual model aliases** — they are the router's abstraction layer. The pipeline tests that these aliases resolve correctly to real LLM providers.

2. **Two API formats tested:**
   - Pipeline integration tests use **Anthropic Messages format** (`/v1/messages`)
   - Local `test.sh` uses **OpenAI Chat Completions format** (`/v1/chat/completions`)
   - Unit tests cover the translation layer between formats

3. **The integration test is entirely inline** in the YAML — there are no external test scripts called by the pipeline. This makes the test harder to run locally in the exact same way as CI.

4. **Skip-on-missing-provider logic** — If "no eligible accounts" appears in the response, the test skips rather than fails. This allows the pipeline to pass even when specific providers aren't configured on the CI runner.

5. **Self-hosted runner** — Uses a self-hosted `Ubuntu` agent pool (not Microsoft-hosted), which means the runner likely has provider API keys configured as pipeline variables.

6. **No dedicated test stage for `test.sh`** — The local `test.sh` script tests additional scenarios (tool calls, OpenAI format) that the pipeline doesn't cover.
