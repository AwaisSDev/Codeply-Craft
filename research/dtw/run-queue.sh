#!/bin/bash
# Every CPU experiment of the Decide-then-Write comparison, one at a time (4 cores,
# nothing else running, so latency numbers are comparable). Waits for the
# Ettin-150M training that is already running, then:
#   export -> evaluate encoders, the LFM3 baseline, the writer variant,
#   LFM3 + attached classifiers, mmBERT, Ettin-400M, more seeds.
# Results: research/dtw/results/<name>.json (+ details/). Logs: $W/logs.
set -u
R=/home/user/Codeply-Craft
W=/tmp/claude-0/-home-user-Codeply-Craft/f765d8e6-66e9-5dbc-bf3b-0813598b766a/scratchpad/dtw
V=$W/../venv/bin/python
L=$HOME/llama.cpp
BENCH=research/dtw/benchmark/bench.jsonl
OUT=research/dtw/results
export HF_HOME=$W/hf
mkdir -p $W/logs $R/$OUT
cd $R

step() { echo "== $(date +%T) $*"; }
export_run() {
  local run=$1
  $V research/dtw/model/export_heads.py $run > /dev/null
  [ -d $run/backbone ] && [ -f $run/backbone/config.json ] && grep -q modernbert $run/backbone/config.json || return 0
  $V $L/convert_hf_to_gguf.py $run/backbone --outtype f16 --outfile $run/backbone-f16.gguf > /dev/null 2>&1
  $L/build/bin/llama-quantize $run/backbone-f16.gguf $run/backbone-q8_0.gguf Q8_0 > /dev/null 2>&1
  $L/build/bin/llama-quantize $run/backbone-f16.gguf $run/backbone-q4_0.gguf Q4_0 > /dev/null 2>&1
}
evaluate() {  # name provider-args... (set and file are the last two of each call below)
  local name=$1; shift
  node ml/eval/run.mjs "$@" --threads 4 --name $name --out $OUT > $W/logs/$name.log 2>&1
  echo "   $name exit $? $(grep -o '"f1": [0-9.]*' $OUT/$name.json 2>/dev/null | head -1)"
}
dtw3() {  # name run [extra provider args]: benchmark, old gold, test-mini
  local name=$1 run=$2; shift 2
  evaluate $name-bench --provider module:research/dtw/runtime/dtw-provider.mjs --dtw-run $run "$@" --set bench --set-file $BENCH
  evaluate $name-gold --provider module:research/dtw/runtime/dtw-provider.mjs --dtw-run $run "$@" --set gold
  evaluate $name-test-mini --provider module:research/dtw/runtime/dtw-provider.mjs --dtw-run $run "$@" --set test-mini
}
train_enc() {  # name hf seed [extra]
  local name=$1 hf=$2 seed=$3; shift 3
  (cd research/dtw/model && $V train_encoder.py --model $hf --train $W/train4k.spans.jsonl --val $W/val.spans.jsonl --out $W/runs/$name-s$seed --epochs 2 --seed $seed --bs 16 "$@" > $W/logs/train-$name-s$seed.log 2>&1)
  echo "   train $name-s$seed exit $? $(grep -o 'done.*' $W/logs/train-$name-s$seed.log | head -c 300)"
}

step "waiting for ettin150-s1 training"
while pgrep -f "train_encoder.py --model jhu-clsp/ettin-encoder-150m" > /dev/null; do sleep 20; done
grep -o 'done.*' $W/runs/ettin150-s1.log | head -c 300; echo

step "1 export ettin150-s1"; export_run $W/runs/ettin150-s1
step "2 decide-then-write, Ettin-150M Q8_0"; dtw3 dtw-ettin150-s1 $W/runs/ettin150-s1
step "2b INT4 export of the same encoder"; evaluate dtw-ettin150-s1-q4-bench --provider module:research/dtw/runtime/dtw-provider.mjs --dtw-run $W/runs/ettin150-s1 --dtw-gguf $W/runs/ettin150-s1/backbone-q4_0.gguf --set bench --set-file $BENCH
step "3 baselines on the benchmark: rules, LFM3 QAD prompt v2 (today's pipeline)"
evaluate rules-bench --provider rules --set bench --set-file $BENCH
evaluate lfm3-qad-v2-bench --provider local:lfm3-1.7b-qad-q4 --set bench --set-file $BENCH
step "4 decide-then-write + LFM3 writer"
evaluate dtw-ettin150-s1-writer-bench --provider module:research/dtw/runtime/dtw-provider.mjs --dtw-run $W/runs/ettin150-s1 --dtw-writer lfm3 --set bench --set-file $BENCH

step "5 LFM3 frozen features (train 4000, val 400)"
$L/build/bin/llama-server -m $HOME/.codeply/models/LFM3-1.7B-QAD-Q4_0.gguf -c 4096 -ub 2048 -b 2048 -t 4 --port 18097 --embedding --pooling none > $W/logs/lfm3-emb.log 2>&1 &
SRV=$!
for i in $(seq 1 120); do curl -s localhost:18097/health | grep -q ok && break; sleep 1; done
$V research/dtw/model/lfm3_features.py 18097 $W/train4k.spans.jsonl $W/lfm3-train > $W/logs/lfm3-feat-train.log 2>&1
$V research/dtw/model/lfm3_features.py 18097 $W/val.spans.jsonl $W/lfm3-val 400 > $W/logs/lfm3-feat-val.log 2>&1
kill $SRV; wait $SRV 2>/dev/null
step "6 train LFM3 heads"
(cd research/dtw/model && $V train_lfm3_heads.py --train-feat $W/lfm3-train --train $W/train4k.spans.jsonl --val-feat $W/lfm3-val --val $W/val.spans.jsonl --out $W/runs/lfm3-heads-s1 > $W/logs/train-lfm3-heads-s1.log 2>&1)
echo "   $(grep -o 'done.*' $W/logs/train-lfm3-heads-s1.log | head -c 300)"
export_run $W/runs/lfm3-heads-s1
step "7 LFM3 + attached classifiers"; dtw3 dtw-lfm3heads-s1 $W/runs/lfm3-heads-s1 --dtw-gguf $HOME/.codeply/models/LFM3-1.7B-QAD-Q4_0.gguf

step "8 mmBERT-base"; train_enc mmbert jhu-clsp/mmBERT-base 1 --freeze-embeddings
export_run $W/runs/mmbert-s1; dtw3 dtw-mmbert-s1 $W/runs/mmbert-s1
step "9 Ettin-400M"; train_enc ettin400 jhu-clsp/ettin-encoder-400m 1
export_run $W/runs/ettin400-s1; dtw3 dtw-ettin400-s1 $W/runs/ettin400-s1
step "10 Ettin-150M seeds 2 and 3"
for s in 2 3; do train_enc ettin150 jhu-clsp/ettin-encoder-150m $s; export_run $W/runs/ettin150-s$s; evaluate dtw-ettin150-s$s-bench --provider module:research/dtw/runtime/dtw-provider.mjs --dtw-run $W/runs/ettin150-s$s --set bench --set-file $BENCH; done
step "all done"
