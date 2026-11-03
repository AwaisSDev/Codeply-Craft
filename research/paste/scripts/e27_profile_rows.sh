#!/usr/bin/env bash
# E27: A3 profile rows (spec v2.2 candidate) at the E24 budget, head_norm on (D2), seed 1, validation only.
# Compared with E24 PASTE-hnon (v2.1) and M1c-hnon on identical data, budget and calibration grid.
# Resumable: rerun the same command.
set -euo pipefail
cd "$(dirname "$0")/.."
PASTE_HOME=${PASTE_HOME:-$HOME}
PY=${PY:-$PASTE_HOME/paste-venv/bin/python}
DATA=${DATA:-$PASTE_HOME/paste-data/train}
RUNS=${RUNS:-$PASTE_HOME/paste-runs/e27}
MIX=${MIX:-$DATA/train-mix-full.jsonl}
TRAIN_ARGS=${TRAIN_ARGS:---epochs 1 --accum 2 --bio-weight 5 --val-tf 10 --ckpt-every 250}
export PASTE_HF_CACHE=${PASTE_HF_CACHE:-$PASTE_HOME/paste-cache/hf}
mkdir -p "$RUNS"
sha256sum "$MIX" > "$RUNS/mix.sha256"
echo "$TRAIN_ARGS" > "$RUNS/train-args.txt"
VAL="$DATA/val-programmatic.jsonl $DATA/api-val/val-api.jsonl"
out="$RUNS/PASTE-rows-hnon"
[ -f "$out/final.pt" ] || $PY -m paste.train --system PASTE --head-norm --profile-rows --train "$MIX:0-1000" "$MIX:3000-4000" \
    --val $VAL --val-limit 200 --seed 1 $TRAIN_ARGS --out "$out"
[ -f "$out/calibration.json" ] || $PY -m paste.calibrate --run "$out" --val $VAL --limit 200
[ -f "$out/addr-diag.json" ] || $PY tools/addr_diag.py --run "$out" --val "$DATA/val-programmatic.jsonl" --limit 30 --threads 2
echo E27 done
