#!/usr/bin/env bash
# Asks for far more output tokens than any balance covers, so SERV answers 402 with the balance and bills nothing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env_file="$here/../../../.env"
key="$(grep '^SERV_API_KEY=' "$env_file" | head -n1 | cut -d= -f2- | tr -d '\r"' )"
curl -4 -sS --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 https://inference-api.openserv.ai/v1/chat/completions \
  -H "Authorization: Bearer $key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","max_completion_tokens":1000000,"messages":[{"role":"system","content":"Reply ok."},{"role":"user","content":"ok"}]}' \
  | grep -oE 'balance is \$[0-9.]+' || echo "balance text not found"
