#!/usr/bin/env bash
# Keep up to 5 free Kaggle CPU sessions busy (Kaggle's batch CPU session limit) with validation-only queue notebooks,
# and fetch each finished kernel's runs.tgz. No GPU, no test or stress data (the notebooks assert it).
#   scripts/kaggle/scheduler.sh COMMIT SLUG...      (SLUGs in priority order; queue file = queues/<slug>.txt)
# Stateless: every pass asks Kaggle for each slug's status, so it can be restarted at any time (the container may be
# reclaimed while the session is idle; Kaggle kernels keep running). A slug is pushed only when it is absent from the
# account's kernel list (never pushed): an API error never re-pushes, which would restart a running kernel.
#   ONCE=1: one pass, then exit.
# Credentials come from the environment. Outputs: $OUT/<slug>/runs.tgz, extracted to $RUNS_OUT/<slug>/ (own directory;
# nothing in it is executed).
set -uo pipefail
cd "$(dirname "$0")/../.."
COMMIT=$1; shift
KAGGLE=${KAGGLE:-kaggle}; PY=${PY:-python}; USER_=${KAGGLE_USERNAME}
PH=${PASTE_HOME:-$HOME}
OUT=${OUT:-$PH/paste-kaggle/out}; NB=${NB:-$PH/paste-kaggle/nb}; RUNS_OUT=${RUNS_OUT:-$PH/paste-runs/kaggle}
EVERY=${EVERY:-600}; MAXS=${MAXS:-5}; ONCE=${ONCE:-0}
mkdir -p "$OUT" "$NB" "$RUNS_OUT"
log() { echo "$(date -u +%FT%TZ) $*"; }
status() {
  if ! grep -qx "$USER_/paste-$1" <<<"$MINE"; then echo NEW; return; fi
  $KAGGLE kernels status "$USER_/paste-$1" 2>&1 | grep -o 'KernelWorkerStatus\.[A-Z_]*' | tail -1 | sed 's/KernelWorkerStatus\.//' || true
}
while true; do
  run=(); new=(); done_=(); other=()
  # existence from the account's own kernel list (the status API answers 404 or "permission denied" for a missing
  # kernel, inconsistently); if the list cannot be read, nothing is pushed in this pass
  MINE=$($KAGGLE kernels list --mine --page-size 100 --csv 2>/dev/null | cut -d, -f1 | grep "^$USER_/")
  for s in "$@"; do
    if [ -f "$RUNS_OUT/$s/FETCHED" ]; then done_+=("$s"); continue; fi
    if [ -z "$MINE" ]; then other+=("$s:list-unavailable"); continue; fi
    st=$(status "$s")
    case "$st" in
      NEW) new+=("$s") ;;
      COMPLETE)
        mkdir -p "$OUT/$s"
        $KAGGLE kernels output "$USER_/paste-$s" -p "$OUT/$s" --file-pattern 'runs.tgz' >/dev/null 2>&1
        if [ -s "$OUT/$s/runs.tgz" ] && mkdir -p "$RUNS_OUT/$s" && tar xzf "$OUT/$s/runs.tgz" -C "$RUNS_OUT/$s" --no-same-owner; then
          touch "$RUNS_OUT/$s/FETCHED"; log "fetched $s"; done_+=("$s")
        else log "COMPLETE, fetch failed (retry next pass): $s"; other+=("$s"); fi ;;
      RUNNING|QUEUED) run+=("$s") ;;
      ERROR|CANCEL*) log "FAILED $s ($st): needs attention"; other+=("$s:$st") ;;
      *) log "status unknown ($st): $s"; other+=("$s:?") ;;
    esac
  done
  while (( ${#run[@]} < MAXS && ${#new[@]} )); do
    s=${new[0]}
    $PY scripts/kaggle/make_notebooks.py --commit "$COMMIT" --cpu-queue "scripts/kaggle/queues/$s.txt" --slug "paste-$s" --out "$NB" >/dev/null
    r=$(bash scripts/kaggle/push.sh "$NB/paste-$s.ipynb" "paste-$s" cpu 2>&1 | tail -1)
    if [[ "$r" == *successfully* ]]; then log "pushed $s"; run+=("$s"); new=("${new[@]:1}")
    else log "push deferred $s: $r"; break; fi
  done
  log "running: ${run[*]:-none} | not pushed: ${new[*]:-none} | fetched: ${#done_[@]} | other: ${other[*]:-none}"
  (( ${#run[@]} + ${#new[@]} + ${#other[@]} )) || { log "all done"; exit 0; }
  [ "$ONCE" = 1 ] && exit 0
  sleep "$EVERY"
done
