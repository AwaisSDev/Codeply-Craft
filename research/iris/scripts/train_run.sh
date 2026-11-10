#!/usr/bin/env bash
# Start or resume a training run detached from the shell (survives the calling command; resumable after a restart).
#   bash scripts/train_run.sh <run-name> [extra --set key=value ...]
set -uo pipefail
cd "$(dirname "$0")/.." && . scripts/env.sh
RUN=$1; shift
mkdir -p runs/$RUN
RESUME=""; [ -f runs/$RUN/ckpt/state.pt ] && RESUME="--resume"
setsid nohup $PY -m codeply_iris.train --config train/iris-0.6b.json --set base=$BASE --set out=runs/$RUN "$@" $RESUME >> runs/$RUN/stdout.log 2>&1 < /dev/null &
echo "started $RUN ${RESUME:-fresh}"
