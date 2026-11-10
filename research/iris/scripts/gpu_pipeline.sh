#!/usr/bin/env bash
# Full train -> validate -> self-output -> retrain -> validate pipeline for one foundation size, on a GPU.
#   bash scripts/gpu_pipeline.sh Qwen/Qwen3-0.6B 0.6b 2e-4
# Uses the transformers backend throughout (no llama.cpp needed). Never touches the test split.
set -uo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-python}; BASE=$1; TAG=$2; LR=${3:-2e-4}
R2=runs/iris-$TAG-r2; R3=runs/iris-$TAG-r3
ev() { $PY -m codeply_iris.evaluate --system iris --model $BASE --adapter $1 --split val --out results/gpu/val/iris-$TAG-$2 --label iris-$TAG-$2 "${@:3}" 2>&1 | tail -1 | cut -c1-1000; }
$PY -m codeply_iris.train --config train/iris-0.6b.json --set base=$BASE --set out=$R2 --set lr=$LR --set epochs=3 --set warmup_steps=20 \
  --set eval_every=50 --set val_examples=120 --set save_every=100 2>&1 | grep -E "^train|val_loss|finished|Error|error" | tail -30
A=$R2/best/adapter; [ -d $A ] || A=$R2/final/adapter
ev $A r2; ev $A r2 --closed-loop
$PY -m codeply_iris.selfplay --model $BASE --adapter $A --out data/built/train-selfplay-$TAG.jsonl 2>&1 | tail -1
$PY - <<PYEOF
import json, random
ex = [json.loads(l) for l in open("data/built/train.jsonl")]
teacher = [e for e in ex if not str(e.get("shard", "")).startswith("syn")]
random.Random(3).shuffle(teacher)
keep = teacher[:int(len(teacher) * 0.6)]
open("data/built/train-r3-replay.jsonl", "w").write("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in keep))
print("r3 replay examples:", len(keep))
PYEOF
$PY -m codeply_iris.train --config train/iris-0.6b.json --set base=$BASE --set out=$R3 --set init_adapter=$A \
  --set train=data/built/train-selfplay-$TAG.jsonl,data/built/train-r3-replay.jsonl --set epochs=2 --set lr=1e-4 --set warmup_steps=5 \
  --set eval_every=25 --set val_examples=120 --set save_every=100 2>&1 | grep -E "^train|val_loss|finished|Error|error" | tail -20
A3=$R3/best/adapter; [ -d $A3 ] || A3=$R3/final/adapter
ev $A3 r3; ev $A3 r3 --closed-loop
echo "PIPELINE_DONE $TAG"
