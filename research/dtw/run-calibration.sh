#!/bin/bash
# Calibration (CALIBRATION-PROTOCOL.md) for every realistic DtW run that exists, one at a time; each model's
# operating points and calibrated results are committed and pushed as they land.
# Usage: W=<scratch> RUNS=<dir with real-ettin*-s*> research/dtw/run-calibration.sh [names...]
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); cd $R
W=${W:?set W}; RUNS=${RUNS:?set RUNS}; mkdir -p $W/calibrate
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TRAILER=$'\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01MFYAyHbBeH3UFEVYbSzRXQ'
NAMES=${*:-real-ettin150-s1 real-ettin150-s2 real-ettin150-s3 real-ettin400-s1 real-ettin400-s2 real-ettin400-s3}
for n in $NAMES; do
  [ -d $RUNS/$n ] || { echo "== $n: not trained yet, skipped"; continue; }
  [ -f research/dtw/results/calibration/dtw-$n-operating-points.json ] && [ -f research/dtw/results/dtw-$n-natural-cal5.json ] && { echo "== $n done"; continue; }
  echo "== $(date +%T) $n"
  python3 research/dtw/calibrate.py --run $RUNS/$n --name dtw-$n --work $W/calibrate/$n || { echo "   $n failed"; continue; }
  git pull -q --rebase origin $BRANCH
  git add research/dtw/results && git commit -q -m "DtW calibration: dtw-$n (val-chosen operating points, test sets at 2:1, 3:1, 5:1)$TRAILER" -- research/dtw/results
  for d in 2 4 8 16; do git push -q -u origin $BRANCH && break; sleep $d; done
done
echo "== all done"
