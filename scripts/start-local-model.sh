#!/usr/bin/env bash
# Start a local OpenAI-compatible model server for cue (rea).
# Defaults: llama.cpp llama-server, Qwen3.5-9B Q4_K_M + its vision projector,
# on http://127.0.0.1:8080/v1 — the default Local Base URL in cue's Settings.
#
# Override with env vars, e.g.
#   CUE_MODEL=~/models/other.gguf CUE_MMPROJ= CUE_PORT=8081 npm run local-model
set -euo pipefail

MODEL="${CUE_MODEL:-$HOME/models/pymaster/Qwen3.5-9B-Q4_K_M.gguf}"
MMPROJ="${CUE_MMPROJ-$HOME/models/pymaster/mmproj-F16.gguf}"
PORT="${CUE_PORT:-8080}"
ALIAS="${CUE_ALIAS:-qwen3.5-9b}"   # must match the model name in cue's Settings
CTX="${CUE_CTX:-8192}"     # screenshot (~1k tokens) + transcript + answer fits easily

command -v llama-server >/dev/null || { echo "llama-server not found (brew install llama.cpp)" >&2; exit 1; }
[[ -f "$MODEL" ]] || { echo "model not found: $MODEL (set CUE_MODEL)" >&2; exit 1; }

args=(-m "$MODEL" --alias "$ALIAS" --host 127.0.0.1 --port "$PORT" -c "$CTX" -ngl 99 --jinja
      -np 1                          # cue sends one request at a time; saves RAM
      --reasoning off)               # overlay answers should start streaming right away
if [[ -n "$MMPROJ" && -f "$MMPROJ" ]]; then
  args+=(--mmproj "$MMPROJ" --image-max-tokens 1024)
else
  args+=(--no-mmproj)
  echo "no vision projector — turn off 'Send screenshots' in cue's Local settings" >&2
fi

echo "cue (rea) local model: $ALIAS on http://127.0.0.1:$PORT/v1" >&2
exec llama-server "${args[@]}"
