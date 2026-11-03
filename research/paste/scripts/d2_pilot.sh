#!/usr/bin/env bash
# D2 pilot (pre-registered: spec v2.1 §6.5, EVALUATION-PROTOCOL §9, BASELINE-PLAN §4).
# PASTE and M1c x head_norm {off, on}; 2,000 option-B episodes; seed 1; validation only.
# Training budget in TRAIN_ARGS (identical for all four arms). E21 (accum 16, 125 steps) was uninformative.
# Resumable: finished runs (final.pt + calibration.json) are skipped; unfinished runs resume from last.pt.
set -euo pipefail
cd "$(dirname "$0")/.."
PASTE_HOME=${PASTE_HOME:-$HOME}
PY=${PY:-$PASTE_HOME/paste-venv/bin/python}
DATA=${DATA:-$PASTE_HOME/paste-data/train}
RUNS=${RUNS:-$PASTE_HOME/paste-runs/d2}
MIX=${MIX:-$DATA/train-mix-full.jsonl}          # built once by data.mix; never rebuilt while a pilot runs
TRAIN_ARGS=${TRAIN_ARGS:---epochs 1}
export PASTE_HF_CACHE=${PASTE_HF_CACHE:-$PASTE_HOME/paste-cache/hf}
mkdir -p "$RUNS"
[ -f "$MIX" ] || { echo "missing $MIX (python -m data.mix)"; exit 1; }
sha256sum "$MIX" > "$RUNS/mix.sha256"
echo "$TRAIN_ARGS" > "$RUNS/train-args.txt"
VAL="$DATA/val-programmatic.jsonl $DATA/api-val/val-api.jsonl"
for sys in PASTE M1c; do
  for hn in off on; do
    out="$RUNS/$sys-hn$hn"
    flag=""; [ "$hn" = on ] && flag="--head-norm"
    if [ ! -f "$out/final.pt" ]; then
      $PY -m paste.train --system $sys $flag --train "$MIX:0-1000" "$MIX:3000-4000" \
        --val $VAL --val-limit 200 --seed 1 $TRAIN_ARGS --out "$out"
    fi
    [ -f "$out/calibration.json" ] || $PY -m paste.calibrate --run "$out" --val $VAL --limit 200
  done
done
$PY - "$RUNS" <<'PYEOF'
import json, os, sys
runs = sys.argv[1]
res = {}
for sys_ in ("PASTE", "M1c"):
    for hn in ("off", "on"):
        c = json.load(open(os.path.join(runs, f"{sys_}-hn{hn}", "calibration.json")))["chosen"]
        res[f"{sys_}-hn{hn}"] = c
mean = {hn: (res[f"PASTE-hn{hn}"]["PE"] + res[f"M1c-hn{hn}"]["PE"]) / 2 for hn in ("off", "on")}
choice = max(mean, key=mean.get)
json.dump({"runs": res, "mean_val_PE": mean, "choice": f"head_norm={choice}"}, open(os.path.join(runs, "D2-choice.json"), "w"), indent=1)
print(json.dumps({"mean_val_PE": mean, "choice": f"head_norm={choice}"}))
PYEOF
