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

## Local Docker Validation

Before concluding work that can affect request routing, translation, provider handling, combo behavior, or streaming, validate against the local dockerized 9router instance when feasible.

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

# Show logs for a specific run
az pipelines runs log show --id <run-id> --org https://dev.azure.com/Knight1988 --project 9router

# Queue a new pipeline run
az pipelines run --name <pipeline-name> --org https://dev.azure.com/Knight1988 --project 9router
```
