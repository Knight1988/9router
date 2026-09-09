# AGENTS.md

## Secret Check Before Commit Or Push

Before creating a commit or pushing a branch, scan tracked changes for secrets or tokens.

- Check staged changes before commit with `git diff --cached master...HEAD` and `git diff --cached`.
- Check branch changes before push with `git diff master...HEAD`.
- Treat anything already present on `master` as baseline and focus on newly introduced exposures.
- Ignore untracked local files such as `.env` or tool state unless they are being added to git.
- Prioritize high-signal findings such as API keys, OAuth client secrets, bearer tokens, JWTs, private keys, and hardcoded credential fallbacks.
- If a new secret-like value is found in tracked changes, stop and ask whether it should be removed, moved to environment variables, or intentionally committed.

## CI/CD Pipeline

The project uses Azure DevOps Pipelines for CI/CD.

## Branch Merge Validation

Before merging a branch, verify that provider and quota configurations are not missing or accidentally removed.

- Check that all expected providers remain configured after merge.
- Check that quota settings are preserved.
- Review the diff carefully for unintended deletions in provider or quota configuration files.

### Merge Regression Prevention

The `origin/master` → `beta` merge at `0570c095` failed Azure run `177854` because conflict resolution preserved compiling code but dropped or changed runtime and test contracts:

- Kiro request translators stopped emitting the top-level `systemPrompt`, breaking OpenAI→Kiro and Claude→Kiro reasoning, agentic, and system-instruction tests.
- `getUsageForProvider` changed from accepting options as its second argument to accepting `proxyOptions` second and options third, breaking existing Open Claude session-refresh callers.
- `tests/auth/saml.test.js` used `node:test`, but Azure executes the complete `tests` tree with Vitest, which reported that file as having no test suite.
- Provider URL/header snapshots and several tests/mocks were stale relative to the merged provider registry and executor contracts.

Before committing or pushing a merge:

- Run the same unit-test command as Azure: `npm --prefix tests test`. A successful application build is not sufficient.
- For every conflicted exported function, compare both parent signatures and search all callers/tests. Preserve compatible calling conventions or migrate every caller in the same merge.
- For request translators and executors, verify returned payload fields—not only syntax—including `systemPrompt`, session metadata, forwarded headers, retry arguments, and provider-specific options.
- Run focused tests for every conflicted subsystem first, then the full Azure unit-test command. For this failure, the minimum focused set was `auth/saml.test.js`, `unit/openclaude-usage-credentials.test.js`, `unit/openai-to-kiro.test.js`, and `translator/claude-kiro-direct.test.js`.
- Regenerate or deliberately reconcile golden snapshots when provider registry URLs, headers, aliases, or provider membership changes. Never retain a snapshot solely because its test file still exists.
- Check that Vitest-discovered tests use Vitest APIs and that module mocks expose every newly imported symbol.
- After pushing, wait for the run triggered by the pushed commit SHA. Do not treat an older successful run on the same branch as validation of the new commit.

### Pipeline Failure Prevention

The post-merge `beta` pipeline repeatedly failed before runs `178010` and `178011` succeeded at commit `58c4268c`. The failures exposed several independent CI and runtime assumptions:

- Azure run `177951` expanded `$(TEST_API_KEY)` inside the Bash script as command substitution, producing `TEST_API_KEY: command not found`. Pass Azure secrets through the task `env:` mapping and reference them as shell variables inside scripts.
- The self-hosted WSL runner inherited the unavailable Tailscale resolver `100.100.100.100`. Docker BuildKit could not resolve `registry-1.docker.io` or `public.ecr.aws`; a successful host lookup alone did not repair the already-running Docker daemon.
- `docker compose up --build -d` continued into readiness and smoke checks after the image build failed, obscuring the root cause with later `no content found` errors.
- The HTTPS entry point created servers directly in `server-https.js`, bypassing `custom-server.js` peer-header stamping. Requests from inside the container were therefore classified as remote and rejected with `API key required for remote API access`.
- Both explicit-certificate and generated self-signed-certificate HTTPS branches required the trusted-peer wrapper. Fixing only one branch left Docker, which generates a certificate on first boot, broken.
- The persistent `9router_data` CI volume retained `requireApiKey=true`. `REQUIRE_API_KEY=false` in Compose did not override the database setting used by `src/sse/handlers/chat.js`.
- The Azure `TEST_API_KEY` value was not a valid key in the persistent application database. Supplying it changed the failure from `Missing API key` to `Invalid API key`.
- Alpine BusyBox `wget` does not support GNU `wget --content-on-error`; this hid response bodies and printed usage text instead. The smoke client now uses the bundled Node runtime.
- `set -euo pipefail` caused expected non-matching response-parsing pipelines and a failing `run_test` call to terminate the script before all diagnostics and the final result summary were emitted.

Before pushing pipeline, Docker, HTTPS-server, authentication, or smoke-test changes:

- Run `npm --prefix tests test` and the focused peer/auth tests: `npm --prefix tests test -- unit/custom-server-peer-headers.test.js unit/dashboard-guard.test.js`.
- Validate both HTTPS construction paths in `server-https.js`: uploaded certificates and generated self-signed certificates must wrap the Next handler with `wrapTrustedPeerHandler`.
- Run `node --check custom-server.js && node --check server-https.js` after server-entry changes.
- Validate the Compose merge with `docker compose -f docker-compose.yml -f docker-compose.ci.yml config`.
- Separate Docker lifecycle steps: run `docker compose build`, fail if all bounded retries fail, then run `docker compose up -d`. Never start readiness or request checks after a failed build.
- On the self-hosted WSL agent, verify registry resolution from both the host and Docker BuildKit. If `/etc/resolv.conf` is repaired, restart Docker and wait for `docker info` before building.
- Make readiness checks assert the expected status or response, not merely that `curl` connected. An authentication error proves the server is listening but not that the tested route is usable.
- Run smoke requests from inside the application container to exercise the same local-request classification as deployed clients. Use Node `fetch` with `NODE_TLS_REJECT_UNAUTHORIZED=0` only for the CI-generated certificate.
- Seed a disposable active API key directly into the isolated CI database when testing the authenticated path. Do not assume an Azure secret exists in the application database, and do not rely on environment variables to override persisted settings unless the runtime explicitly implements that override.
- Under `set -euo pipefail`, append `|| true` only to commands whose nonzero status is intentionally captured and evaluated, such as response extraction and per-model aggregation. Keep infrastructure, seeding, readiness, and final aggregate failures fatal.
- Ensure cleanup runs on success and failure so containers, resolver changes, and disposable CI credentials do not leak into later self-hosted-agent jobs.
- After pushing, confirm the exact commit SHA completed every stage. For this incident, runs `178010` and `178011` succeeded for `58c4268cfcb50785af4e94f37d2f44c310e25fe9`; earlier success or a run for another SHA is not evidence.

## Local Docker Validation

Before concluding work that can affect request routing, translation, provider handling, combo behavior, or streaming, validate against the local dockerized 9router instance when feasible.

- Rebuild Docker Compose before testing with `docker compose build`.
- Run `./test.sh` for standard local docker validation.
- Prefer testing with the production-like local DB when available.
- Use the local HTTPS endpoint `https://localhost:20129/v1/chat/completions`.
- Include at least one test that ends with a trailing assistant message when changing OpenAI-format routing for providers such as `open-claude` or `troll-llm`, since these providers can reject assistant prefill.
- If local validation cannot be run, explicitly state that in the final response.

- **Pipeline URL:** https://dev.azure.com/Knight1988/9router/_build

### Monitoring Pipeline Runs

Use the Azure CLI (`az`) to monitor pipeline runs:

```bash
# List recent pipeline runs
az pipelines runs list --org https://dev.azure.com/Knight1988 --project 9router

# Show details of a specific run
az pipelines runs show --id <run-id> --org https://dev.azure.com/Knight1988 --project 9router

# Show available log sections (the installed Azure CLI has no `az pipelines runs log show` command)
az devops invoke --area build --resource logs --route-parameters project=9router buildId=<run-id> --org https://dev.azure.com/Knight1988 --api-version 7.1

# Show one log section
az devops invoke --area build --resource logs --route-parameters project=9router buildId=<run-id> logId=<log-id> --org https://dev.azure.com/Knight1988 --api-version 7.1

# Queue a new pipeline run
az pipelines run --name <pipeline-name> --org https://dev.azure.com/Knight1988 --project 9router
```
