#!/usr/bin/env bash
# 2026-11-07: push the T4 smoke (recipe flags; CENTRAL-TEST-PLAN §3 step 1), or fetch its smoke.json when complete.
#   scripts/kaggle/t4_smoke.sh push            # after `kaggle quota` shows GPU hours
#   scripts/kaggle/t4_smoke.sh fetch OUT_DIR    # when `kaggle kernels status <user>/paste-smoke` is COMPLETE
# Credentials from the environment. The notebook pins the current HEAD (must be pushed to the branch first).
set -euo pipefail
cd "$(dirname "$0")/../.."
KAGGLE=${KAGGLE:-kaggle}; PY=${PY:-python}
case "$1" in
  push)
    git fetch -q origin research/paste-architecture
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/research/paste-architecture)" ] || { echo "push HEAD to the branch first"; exit 1; }
    nb=$(mktemp -d)
    $PY scripts/kaggle/make_notebooks.py --commit "$(git rev-parse HEAD)" --paste-flags=--profile-rows \
      --smoke-args="--closed-loop 0.5 --lr-enc 1e-4" --out "$nb" >/dev/null
    KAGGLE=$KAGGLE bash scripts/kaggle/push.sh "$nb/paste-smoke.ipynb" paste-smoke gpu ;;
  fetch)
    mkdir -p "$2"; $KAGGLE kernels output "$KAGGLE_USERNAME/paste-smoke" -p "$2" --file-pattern 'smoke.json' >/dev/null
    ls -la "$2/smoke.json" ;;
  *) echo "usage: $0 push | fetch OUT_DIR"; exit 2 ;;
esac
