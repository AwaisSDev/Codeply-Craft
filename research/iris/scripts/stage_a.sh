#!/usr/bin/env bash
# Stage A: first look on validation. Stops run r1, rebuilds the data, exports r1 to GGUF, and evaluates
# baselines and r1 on the validation split (open loop). Usage: bash scripts/stage_a.sh
set -uo pipefail
cd "$(dirname "$0")/.." && . scripts/env.sh
pkill -f codeply_iris.train; sleep 3
$PY -m codeply_iris.build --raw data/raw --out data/built | grep -E "^(train|val|test|leak)" | cut -c1-260
$PY -m codeply_iris.export --base $BASE --adapter runs/iris-0.6b-r1/ckpt/adapter --out $IRIS_WORK/out/r1 --name iris-r1 --llama-cpp $LLAMA --quant Q8_0 > $IRIS_WORK/out-r1-export.log 2>&1 || { tail -5 $IRIS_WORK/out-r1-export.log; exit 1; }
for s in nothing rules; do $PY -m codeply_iris.evaluate --system $s --split val --out results/val/$s | tail -1; done
$PY -m codeply_iris.evaluate --system zeroshot --model $BASE_GGUF --constrain --split val --out results/val/zeroshot-qwen3-0.6b --label zeroshot-qwen3-0.6b | tail -1
$PY -m codeply_iris.evaluate --system iris --model $IRIS_WORK/out/r1/iris-r1-Q8_0.gguf --split val --out results/val/iris-r1 --label iris-r1 | tail -1
echo STAGE_A_DONE
