#!/usr/bin/env bash
# Keep up to 5 free Kaggle CPU sessions busy (Kaggle's batch CPU session limit) with validation-only queue notebooks,
# and fetch each finished kernel's runs.tgz.  No GPU, no test or stress data (the notebooks assert it).
#   scripts/kaggle/scheduler.sh COMMIT SLUG...      (SLUGs in priority order; queue file = queues/<slug>.txt)
# Credentials come from the environment. Outputs: $OUT/<slug>/runs.tgz, extracted to $RUNS_OUT/<slug>/.
# Each extraction goes to its own new directory; nothing in it is executed.
set -uo pipefail
cd "$(dirname "$0")/../.."
COMMIT=$1; shift
KAGGLE=${KAGGLE:-kaggle}; PY=${PY:-python}; USER_=${KAGGLE_USERNAME}
OUT=${OUT:-$HOME/paste-kaggle/out}; NB=${NB:-$HOME/paste-kaggle/nb}; RUNS_OUT=${RUNS_OUT:-$HOME/paste-runs/kaggle}
EVERY=${EVERY:-600}; MAXS=${MAXS:-5}
ACTIVE=${ACTIVE:-}                                  # slugs already running before this scheduler started
pending=("$@"); running=($ACTIVE)
mkdir -p "$OUT" "$NB" "$RUNS_OUT"
log() { echo "$(date -u +%FT%TZ) $*"; }
status() { $KAGGLE kernels status "$USER_/paste-$1" 2>&1 | tail -1 | sed 's/.*status "KernelWorkerStatus\.\(.*\)"/\1/'; }
while (( ${#pending[@]} + ${#running[@]} )); do
  still=()
  for s in "${running[@]}"; do
    st=$(status "$s")
    case "$st" in
      COMPLETE)
        mkdir -p "$OUT/$s" && $KAGGLE kernels output "$USER_/paste-$s" -p "$OUT/$s" --file-pattern 'runs.tgz' >/dev/null 2>&1
        if [ -s "$OUT/$s/runs.tgz" ]; then
          mkdir -p "$RUNS_OUT/$s" && tar xzf "$OUT/$s/runs.tgz" -C "$RUNS_OUT/$s" --no-same-owner && log "fetched $s"
        else log "COMPLETE but no runs.tgz yet: $s"; still+=("$s"); fi ;;
      ERROR|CANCEL*) log "FAILED $s ($st)" ;;
      *) still+=("$s") ;;
    esac
  done
  running=("${still[@]}")
  while (( ${#running[@]} < MAXS && ${#pending[@]} )); do
    s=${pending[0]}
    $PY scripts/kaggle/make_notebooks.py --commit "$COMMIT" --cpu-queue "scripts/kaggle/queues/$s.txt" --slug "paste-$s" --out "$NB" >/dev/null
    r=$(bash scripts/kaggle/push.sh "$NB/paste-$s.ipynb" "paste-$s" cpu 2>&1 | tail -1)
    if [[ "$r" == *successfully* ]]; then log "pushed $s"; running+=("$s"); pending=("${pending[@]:1}")
    else log "push deferred $s: $r"; break; fi
  done
  log "running: ${running[*]:-none} | pending: ${pending[*]:-none}"
  (( ${#pending[@]} + ${#running[@]} )) && sleep "$EVERY"
done
log "all done"
