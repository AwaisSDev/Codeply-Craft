#!/usr/bin/env bash
# Restart this container's Iris research jobs after a container restart (idempotent; run at every check-in):
#   * llama-server on :8080 (Qwen3-4B-Instruct Q4_K_M) and :8081 (LFM3-1.7B QAD Q4_0, production settings --swa-full)
#   * the resumable job list in $PASTE_HOME/paste-runs/iris-jobs.txt (one shell command per line; each must be
#     resumable; a line is re-run only if its process is not already running)
# Model files and llama.cpp build live in $PASTE_HOME/paste-tools (re-creatable: README in RESTORE.md).
set -uo pipefail
cd "$(dirname "$0")/.."
PH=${PASTE_HOME:-$HOME}
BIN=$PH/paste-tools/llamacpp/src/build/bin
M=$PH/paste-tools/models
running() { ps -eo args | grep -v grep | grep -qF -- "$1"; }
serve() {   # port model threads extra
  if ! running "--port $1"; then
    (cd "$BIN" && LD_LIBRARY_PATH=. nohup ./llama-server -m "$M/$2" -t "$3" -c 8192 $4 --host 127.0.0.1 --port "$1" \
      > "$PH/paste-tools/llama-server-$1.log" 2>&1 &)
    echo "started llama-server :$1 ($2)"
  fi
}
[ -x "$BIN/llama-server" ] && serve 8080 Qwen3-4B-Instruct-2507-Q4_K_M.gguf 2 "" && serve 8081 LFM3-1.7B-QAD-Q4_0.gguf 2 "--swa-full"
for p in 8080 8081; do for i in $(seq 1 60); do curl -s "http://127.0.0.1:$p/health" | grep -q '"ok"' && break; sleep 2; done; done
JOBS=$PH/paste-runs/iris-jobs.txt
if [ -f "$JOBS" ]; then
  while IFS= read -r cmd; do
    [[ -z "$cmd" || "$cmd" == \#* ]] && continue
    tag=$(echo "$cmd" | grep -o -- '--out [^ ]*' | head -1)
    if [ -n "$tag" ] && ! running "$tag"; then
      nohup bash -c "$cmd" >> "$PH/paste-runs/iris-jobs.log" 2>&1 &
      echo "resumed: ${cmd:0:120}"
    fi
  done < "$JOBS"
fi
echo "iris keepalive ok $(date -u +%T)"
