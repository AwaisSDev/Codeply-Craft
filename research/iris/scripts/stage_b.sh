#!/usr/bin/env bash
# Stage B: evaluate r2 on validation (open + closed loop), generate self-output data with r2, train r3 on it,
# evaluate r3 on validation. Selection between r2 and r3 is made on validation, closed loop (EXPERIMENTS.md).
set -uo pipefail
cd "$(dirname "$0")/.." && . scripts/env.sh
O=$IRIS_WORK/out
ev() { $PY -m codeply_iris.evaluate --system iris --model $O/$1/iris-$1-Q8_0.gguf --split val --out results/val/iris-$1 --label iris-$1 "${@:2}" | tail -1 | cut -c1-900; }
A=runs/iris-0.6b-r2/best/adapter; [ -d $A ] || A=runs/iris-0.6b-r2/final/adapter
$PY -m codeply_iris.export --base $BASE --adapter $A --out $O/r2 --name iris-r2 --llama-cpp $LLAMA --quant Q8_0 > $O-r2-export.log 2>&1 || { tail -5 $O-r2-export.log; exit 1; }
ev r2; ev r2 --closed-loop
$PY -m codeply_iris.build --raw data/raw --out data/built | grep -E "^(train|val|test|leak)" | cut -c1-200
$PY -m codeply_iris.selfplay --model $O/r2/iris-r2-Q8_0.gguf --out data/built/train-selfplay.jsonl | tail -1
$PY - <<'PYEOF'
import json, random
ex = [json.loads(l) for l in open("data/built/train.jsonl")]
teacher = [e for e in ex if not str(e.get("shard", "")).startswith("syn")]
random.Random(3).shuffle(teacher)
keep = teacher[:int(len(teacher) * 0.45)]
open("data/built/train-r3-replay.jsonl", "w").write("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in keep))
print("r3 replay examples:", len(keep))
PYEOF
rm -rf runs/iris-0.6b-r3
$PY -m codeply_iris.train --config train/iris-0.6b.json --set base=$BASE --set out=runs/iris-0.6b-r3 --set init_adapter=$A \
  --set train=data/built/train-selfplay.jsonl,data/built/train-r3-replay.jsonl --set epochs=1 --set lr=1e-4 --set warmup_steps=5 \
  --set eval_every=20 --set val_examples=60 > runs/r3-stdout.log 2>&1
grep val_loss runs/iris-0.6b-r3/train-log.jsonl | tail -3
A3=runs/iris-0.6b-r3/best/adapter; [ -d $A3 ] || A3=runs/iris-0.6b-r3/final/adapter
$PY -m codeply_iris.export --base $BASE --adapter $A3 --out $O/r3 --name iris-r3 --llama-cpp $LLAMA --quant Q8_0 > $O-r3-export.log 2>&1 || { tail -5 $O-r3-export.log; exit 1; }
ev r3; ev r3 --closed-loop
echo STAGE_B_DONE
