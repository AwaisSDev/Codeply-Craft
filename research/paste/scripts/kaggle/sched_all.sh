#!/usr/bin/env bash
# One stateless scheduler pass over every validation queue of the recipe experiments, in priority order (long
# learning-curve runs first: they are the critical path). Run at each check-in; credentials from the environment.
#   PASTE_HOME=/home/user KAGGLE=... PY=... scripts/kaggle/sched_all.sh [COMMIT]
cd "$(dirname "$0")"
ONCE=${ONCE:-1} exec bash scheduler.sh "${1:-23bdec26}" lc-paste-a lc-m1c-a lr-paste lr-m1c var-v2-paste \
  lc-paste-b lc-m1c-b lc-paste-c lc-m1c-c var-v2-m1c var-v1-m1c var-v3-paste var-v3-m1c var-v4-paste var-v4-m1c
