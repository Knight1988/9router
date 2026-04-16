# AGENTS.md

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
