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
