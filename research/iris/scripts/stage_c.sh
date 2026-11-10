#!/usr/bin/env bash
# Stage C: select on validation (closed loop), freeze, evaluate once on test, package the release, smoke-test it.
set -uo pipefail
cd "$(dirname "$0")/.." && . scripts/env.sh
O=$IRIS_WORK/out
SEL=$($PY - <<'PYEOF'
import json, os
best = None
for r in ("r2", "r3"):
    f = f"results/val/iris-{r}/result-val-closed.json"
    if os.path.exists(f):
        m = json.load(open(f))["metrics"]
        key = (round(m["extraction_f1"], 3), -round(m["false_memory_share"], 3))
        best = (key, r) if best is None or key > best[0] else best
print(best[1])
PYEOF
)
echo "SELECTED $SEL (rule: highest validation closed-loop extraction F1, then lower false-memory share)"
G=$O/$SEL/iris-$SEL-Q8_0.gguf
$PY - "$SEL" "$G" <<'PYEOF'
import hashlib, json, sys, time
sel, g = sys.argv[1], sys.argv[2]
h = hashlib.sha256(open(g, "rb").read()).hexdigest()
json.dump({"selected": sel, "gguf": g.split("/")[-1], "sha256": h, "decoding": {"temperature": 0, "constrained": False, "max_new_tokens": 900},
           "guard": "contract.guard (iris.ops/1)", "frozen_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
          open("results/FROZEN.json", "w"), indent=1)
print("frozen", sel, h)
PYEOF
for s in nothing rules; do $PY -m codeply_iris.evaluate --system $s --split test --final --out results/test/$s | tail -1 | cut -c1-600; done
$PY -m codeply_iris.evaluate --system iris --model $G --split test --final --out results/test/iris-1 --label iris-1 | tail -1 | cut -c1-900
$PY -m codeply_iris.evaluate --system iris --model $G --split test --final --closed-loop --out results/test/iris-1 --label iris-1 | tail -1 | cut -c1-900
$PY -m codeply_iris.evaluate --system zeroshot --model $BASE_GGUF --constrain --split test --final --out results/test/zeroshot-qwen3-0.6b --label zeroshot-qwen3-0.6b | tail -1 | cut -c1-600
$PY -m codeply_iris.evaluate --system zeroshot --model $BASE_GGUF --constrain --split test --final --closed-loop --out results/test/zeroshot-qwen3-0.6b --label zeroshot-qwen3-0.6b | tail -1 | cut -c1-600
# release
A=runs/iris-0.6b-$SEL/best/adapter; [ -d $A ] || A=runs/iris-0.6b-$SEL/final/adapter
rm -rf $O/release && $PY -m codeply_iris.export --base $BASE --adapter $A --out $O/release --name iris-1 --llama-cpp $LLAMA --quant Q8_0 Q4_K_M > $O-release-export.log 2>&1 || { tail -5 $O-release-export.log; exit 1; }
W=release/weights && rm -rf $W && mkdir -p $W/adapter
cp $A/adapter_config.json $A/adapter_model.safetensors $W/adapter/
cp $O/release/hf/config.json $O/release/hf/generation_config.json $O/release/hf/tokenizer.json $O/release/hf/tokenizer_config.json $W/ 2>/dev/null
for q in Q8_0 Q4_K_M; do python3 release/pack.py split $O/release/iris-1-$q.gguf --out $W; done
cp $O/release/MANIFEST.json $W/EXPORT-MANIFEST.json
# smoke test from the split parts only, in a fresh directory
T=$IRIS_WORK/smoke && rm -rf $T && mkdir -p $T && python3 release/pack.py join --dir $W --out $T
(cd $T && $PY /home/user/iris/research/iris/integration/example.py $T/iris-1-Q8_0.gguf) > results/smoke-example.txt 2>&1; tail -4 results/smoke-example.txt
$IRIS_LLAMA_SERVER -m $T/iris-1-Q4_K_M.gguf --host 127.0.0.1 --port 8093 -c 8192 --parallel 1 --no-webui -t 4 > /dev/null 2>&1 & SP=$!
until curl -sf http://127.0.0.1:8093/health >/dev/null; do sleep 1; done
IRIS_URL=http://127.0.0.1:8093/v1 node integration/iris-provider.test.mjs > results/smoke-provider.txt 2>&1; tail -3 results/smoke-provider.txt
echo "llama-server RSS (MB, Q4_K_M, ctx 8192): $(($(ps -o rss= -p $SP) / 1024))" | tee -a results/smoke-provider.txt
kill $SP
echo STAGE_C_DONE
