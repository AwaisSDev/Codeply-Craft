#!/usr/bin/env bash
# Serial experiment queue (validation only). Each non-comment line of QUEUE:
#   NAME | SYSTEM | TRAIN_SLICES | EXTRA_TRAIN_ARGS
# runs `paste.train` into $RUNS/NAME (skipped if final.pt exists; resumes from last.pt), then
# `tools/val_sweep.py` on the full val set (skipped per threshold if done). Lines can be appended while it runs:
# the file is re-read after every run. Stop: touch $RUNS/STOP.
set -uo pipefail
cd "$(dirname "$0")/.."
PASTE_HOME=${PASTE_HOME:-$HOME}
PY=${PY:-$PASTE_HOME/paste-venv/bin/python}
DATA=${DATA:-$PASTE_HOME/paste-data/train}
RUNS=${RUNS:-$PASTE_HOME/paste-runs/q}
QUEUE=${QUEUE:-$RUNS/queue.txt}
GRID=${GRID:-0.8 0.9 0.95 0.98}
export PASTE_HF_CACHE=${PASTE_HF_CACHE:-$PASTE_HOME/paste-cache/hf}
VAL_API=${VAL_API:-$DATA/api-val/val-api.jsonl}
VAL="$DATA/val-programmatic.jsonl $VAL_API"
MIX=$DATA/train-mix-full.jsonl
while true; do
  [ -f "$RUNS/STOP" ] && { echo "STOP file"; exit 0; }
  next=""
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    name=$(echo "$line" | cut -d'|' -f1 | xargs)
    [ -f "$RUNS/$name/DONE" ] || [ -f "$RUNS/$name/FAILED" ] || { next="$line"; break; }
  done < "$QUEUE"
  [ -z "$next" ] && { echo "queue empty"; exit 0; }
  name=$(echo "$next" | cut -d'|' -f1 | xargs); sys=$(echo "$next" | cut -d'|' -f2 | xargs)
  slices=$(echo "$next" | cut -d'|' -f3 | xargs); args=$(echo "$next" | cut -d'|' -f4)
  tr=""; for s in $slices; do tr="$tr $MIX:$s"; done
  out="$RUNS/$name"; mkdir -p "$out"
  echo "== $(date -u +%FT%TZ) $name: $sys $slices $args"
  if [ ! -f "$out/final.pt" ]; then
    $PY -m paste.train --system $sys --train $tr --val $VAL --seed ${SEED:-1} $args --out "$out" > "$out/train.out" 2>&1 \
      || { echo "train failed: $name"; tail -5 "$out/train.out"; touch "$out/FAILED"; continue; }
  fi
  $PY tools/val_sweep.py --run "$out" --val $VAL --grid $GRID > "$out/sweep.out" 2>&1 \
    || { echo "sweep failed: $name"; tail -5 "$out/sweep.out"; touch "$out/FAILED"; continue; }
  touch "$out/DONE"; echo "== done $name $(grep -o '"val_pooled_PE": [0-9.]*' "$out/train.out" | tail -1)"
done
