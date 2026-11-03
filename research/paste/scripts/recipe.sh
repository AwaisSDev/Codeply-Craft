#!/usr/bin/env bash
# Apply the pre-registered recipe rules (tools/choose_recipe.py) to every validation run that exists so far.
# Local runs: $RUNS/{e27,d2b,q}; Kaggle CPU runs: $KRUNS/<slug>/runs/<NAME> (scripts/kaggle/scheduler.sh).
#   scripts/recipe.sh OUT.json
set -uo pipefail
cd "$(dirname "$0")/.."
RUNS=${RUNS:-${PASTE_HOME:-$HOME}/paste-runs}; KRUNS=${KRUNS:-$RUNS/kaggle}; PY=${PY:-python}
declare -A M=(
  [V0/PASTE]=$RUNS/e27/PASTE-rows-hnon [V0/M1c]=$RUNS/d2b/M1c-hnon
  [V1/PASTE]=$RUNS/q/V1-PASTE [V1/M1c]=$KRUNS/var-v1-m1c/runs/V1-M1c [V3/PASTE]=$KRUNS/var-v3-paste/runs/V3-PASTE [V3/M1c]=$KRUNS/var-v3-m1c/runs/V3-M1c
  [V2/PASTE]=$KRUNS/var-v2-paste/runs/V2-PASTE [V2/M1c]=$KRUNS/var-v2-m1c/runs/V2-M1c
  [V4/PASTE]=$KRUNS/var-v4-paste/runs/V4-PASTE [V4/M1c]=$KRUNS/var-v4-m1c/runs/V4-M1c
  [S2/PASTE]=$KRUNS/var-s2-paste/runs/S2-PASTE
  [LR3e-5/PASTE]=$KRUNS/lr-paste/runs/LR3e5-PASTE [LR1e-4/PASTE]=$KRUNS/lr-paste/runs/LR1e4-PASTE
  [LR3e-5/M1c]=$KRUNS/lr-m1c/runs/LR3e5-M1c [LR1e-4/M1c]=$KRUNS/lr-m1c/runs/LR1e4-M1c
  [LC1500/PASTE]=$KRUNS/lc-paste-a/runs/LC1500-PASTE [LC3000/PASTE]=$KRUNS/lc-paste-a/runs/LC3000-PASTE
  [LC1500/M1c]=$KRUNS/lc-m1c-a/runs/LC1500-M1c [LC3000/M1c]=$KRUNS/lc-m1c-a/runs/LC3000-M1c
  [LC6000/PASTE]=$KRUNS/lc-paste-b/runs/LC6000-PASTE [LC6000/M1c]=$KRUNS/lc-m1c-b/runs/LC6000-M1c
  [LC3000x2/PASTE]=$KRUNS/lc-paste-c/runs/LC3000x2-PASTE [LC3000x2/M1c]=$KRUNS/lc-m1c-c/runs/LC3000x2-M1c
)
args=(); missing=()
for k in "${!M[@]}"; do
  d=${M[$k]}                            # complete = the whole 0.80-0.98 sweep grid exists (same grid for every run)
  if [ -f "$d/sweep/th0.80.json" ] && [ -f "$d/sweep/th0.90.json" ] && [ -f "$d/sweep/th0.95.json" ] && [ -f "$d/sweep/th0.98.json" ]; then args+=("$k=${M[$k]}"); else missing+=("$k"); fi
done
echo "available: ${#args[@]}  missing: ${missing[*]:-none}"
$PY tools/choose_recipe.py --runs "${args[@]}" --out "$1"
