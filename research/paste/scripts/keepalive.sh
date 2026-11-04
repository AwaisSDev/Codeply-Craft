#!/usr/bin/env bash
# Restart this session's background jobs if a container reclaim killed them (idempotent; run at every check-in):
#   * the Kaggle scheduler loop (scripts/kaggle/sched_all.sh with ONCE=0, a pass every $EVERY s);
#   * the local queue in $PASTE_HOME/paste-runs/q2 (S2-PASTE), which resumes from its last.pt checkpoint.
# Credentials come from the environment.
set -uo pipefail
cd "$(dirname "$0")/.."
PH=${PASTE_HOME:-$HOME}
running() { ps -eo args | grep -v grep | grep -q "$1"; }
# the scheduler takes a lock, so a second loop exits at once
ONCE=0 EVERY=${EVERY:-180} nohup bash scripts/kaggle/sched_all.sh >> "$PH/paste-kaggle/scheduler.log" 2>&1 &
Q=$PH/paste-runs/q2
if [ -f "$Q/queue.txt" ] && ! running "scripts/queue.sh" && ! running "paste.train" && ! running "val_sweep"; then
  pending=$(grep -v '^#' "$Q/queue.txt" | cut -d'|' -f1 | xargs -n1 | while read -r n; do [ -f "$Q/$n/DONE" ] || [ -f "$Q/$n/FAILED" ] || echo "$n"; done)
  if [ -n "$pending" ]; then
    RUNS=$Q QUEUE=$Q/queue.txt nohup bash scripts/queue.sh >> "$Q/queue.log" 2>&1 &
    echo "restarted local queue (resumes from last.pt): $pending"
  fi
fi
echo "keepalive ok $(date -u +%T)"
