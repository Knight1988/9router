#!/usr/bin/env bash
# check-pipeline.sh — print latest Azure DevOps pipeline run status.
#
# Auth: uses 'az devops' CLI (run 'az login' if needed).
#       Override with AZDO_PAT env var (configures az devops auth automatically).
#
# Fixed:
#   org=https://dev.azure.com/Knight1988  project=9router  pipeline_id=15
#
# Exit codes:
#   0 — succeeded or inProgress
#   1 — failed or canceled
#   2 — usage/setup error
set -euo pipefail

ORG_URL="https://dev.azure.com/Knight1988"
PROJECT="9router"
PIPELINE_ID="15"

if ! command -v az &>/dev/null; then
  echo "error: 'az' CLI not found; install Azure CLI" >&2
  exit 2
fi

if [[ -n "${AZDO_PAT:-}" ]]; then
  export AZURE_DEVOPS_EXT_PAT="$AZDO_PAT"
fi

az devops configure --defaults organization="$ORG_URL" project="$PROJECT" 2>/dev/null

run=$(az pipelines runs list \
  --pipeline-id "$PIPELINE_ID" \
  --top 1 \
  --output json 2>/dev/null | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)[0]))") \
  || { echo "error: failed to fetch pipeline runs; run 'az login'" >&2; exit 2; }

name=$(printf '%s' "$run" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('definition',{}).get('name','Pipeline'))")
run_id=$(printf '%s' "$run" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['id'])")
build_num=$(printf '%s' "$run" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('buildNumber',''))")
status=$(printf '%s' "$run" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))")
result=$(printf '%s' "$run" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result') or '')")
start=$(printf '%s' "$run" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('startTime') or '')")
finish=$(printf '%s' "$run" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('finishTime') or '')")
url="${ORG_URL}/${PROJECT}/_build/results?buildId=${run_id}"

duration_str() {
  local s="$1" e="$2"
  local se ee elapsed
  se=$(date -d "$s" +%s 2>/dev/null) || return
  ee=$(date -d "$e" +%s 2>/dev/null) || return
  elapsed=$(( ee - se ))
  printf '%dm%ds' $(( elapsed / 60 )) $(( elapsed % 60 ))
}

if [[ "$status" == "inProgress" && -n "$start" ]]; then
  dur=$(duration_str "$start" "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" 2>/dev/null || echo "")
  [[ -n "$dur" ]] && status_str="inProgress (running ${dur})" || status_str="inProgress"
elif [[ "$status" == "completed" && -n "$result" ]]; then
  dur=$(duration_str "$start" "$finish" 2>/dev/null || echo "")
  [[ -n "$dur" ]] && status_str="${result} (${dur})" || status_str="$result"
else
  status_str="${status}${result:+ / $result}"
fi

printf '%s  %s  #%s  %s\n%s\n' "$name" "$build_num" "$run_id" "$status_str" "$url"

case "$result" in
  failed|canceled) exit 1 ;;
  *) exit 0 ;;
esac
