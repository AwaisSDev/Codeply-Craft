#!/usr/bin/env bash
# Block until a training run finishes (DONE file) or its process dies; print the last log lines.
cd "$(dirname "$0")/.."
RUN=$1
until [ -f runs/$RUN/DONE ] || ! pgrep -f "out=runs/$RUN" > /dev/null; do sleep 30; done
[ -f runs/$RUN/DONE ] && echo "RUN_DONE $(cat runs/$RUN/DONE)" || echo "RUN_DIED (resume with scripts/train_run.sh $RUN ...)"
grep val_loss runs/$RUN/train-log.jsonl | tail -4; tail -1 runs/$RUN/train-log.jsonl
