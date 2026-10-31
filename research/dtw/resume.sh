#!/bin/bash
# Rebuild the CPU environment from nothing and run every remaining Decide-then-Write
# experiment, saving as it goes so a lost container costs only setup time:
#   results  -> committed + pushed to this branch after every evaluation
#   models   -> heads + GGUF backbones pushed to the orphan branch `dtw-artifacts`
#               (files over 90 MB split into .partNN; `cat x.part* > x` to restore)
# Usage: W=/some/scratch research/dtw/resume.sh   (one job at a time on 4 cores)
set -u
R=$(cd "$(dirname "$0")/../.." && pwd)
W=${W:?set W to a scratch directory}
V=${V:-$W/venv/bin/python}
L=${L:-$HOME/llama.cpp}
BRANCH=$(git -C $R rev-parse --abbrev-ref HEAD)
BENCH=research/dtw/benchmark/bench.jsonl
OUT=research/dtw/results
ART=$W/artifacts
export HF_HOME=$W/hf CODEPLY_LLAMA_SERVER=$L/build/bin/llama-server
mkdir -p $W/logs $W/runs $R/$OUT
cd $R
step() { echo "== $(date +%T) $*"; }
TRAILER=$'\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01PFdKPZVeAokuHGdsJQrAPa'
push() { for d in 2 4 8 16; do git -C "$1" push -q -u origin "$2" && return 0; sleep $d; done; echo "   push of $2 failed"; }

# ---------- setup ----------
step "setup: python"
[ -x $V ] || python3 -m venv $W/venv
$W/venv/bin/pip install -q --index-url https://download.pytorch.org/whl/cpu torch
$W/venv/bin/pip install -q transformers numpy safetensors sentencepiece protobuf huggingface_hub accelerate scipy
step "setup: llama.cpp"
if [ ! -x $L/build/bin/llama-server ] || [ ! -x $L/build/bin/llama-quantize ]; then
  [ -d $L ] || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp $L
  (cd $L && cmake -B build -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release > $W/logs/cmake.log 2>&1 \
     && cmake --build build -j 4 --target llama-server llama-quantize >> $W/logs/cmake.log 2>&1) || { echo "llama.cpp build failed"; exit 1; }
fi
$W/venv/bin/pip install -q -e $L/gguf-py
step "setup: LFM3 model"
node scripts/context/fetch-model.mjs lfm3-1.7b-qad-q4 > $W/logs/fetch-lfm3.log 2>&1 || { echo "LFM3 fetch failed"; tail -3 $W/logs/fetch-lfm3.log; }
LFM3=$HOME/.codeply/models/LFM3-1.7B-QAD-Q4_0.gguf

step "setup: data"
for s in train val; do
  [ -s $W/$s.spans.jsonl ] && continue
  node research/dtw/data/dump.mjs ml/data/out/$s.jsonl > $W/$s.inputs.jsonl
  python3 research/dtw/data/align.py $W/$s.inputs.jsonl $W/$s.spans.jsonl > $W/logs/align-$s.log 2>&1
done
head -n 4000 $W/train.spans.jsonl > $W/train4k.spans.jsonl
wc -l $W/*.spans.jsonl

# ---------- saving ----------
if [ ! -d $ART/.git ] && [ ! -f $ART/.git ]; then
  git fetch -q origin dtw-artifacts 2>/dev/null
  if git rev-parse -q --verify origin/dtw-artifacts > /dev/null; then git worktree add -q $ART origin/dtw-artifacts -B dtw-artifacts
  else git worktree add -q --orphan -b dtw-artifacts $ART; fi
fi
save_run() {  # run-dir: heads + config + GGUF backbones (not the LFM3 base model) to dtw-artifacts
  local run=$1 name; name=$(basename $run)
  mkdir -p $ART/$name
  for f in heads.bin heads.json heads.pt config.json train-log.jsonl backbone-q8_0.gguf backbone-q4_0.gguf; do
    [ -f $run/$f ] || continue
    if [ $(stat -c %s $run/$f) -gt 94371840 ]; then split -b 90m -d $run/$f $ART/$name/$f.part; else cp $run/$f $ART/$name/; fi
  done
  (cd $ART && git add -A $name && git commit -q -m "DtW artifacts: $name$TRAILER" && push $ART dtw-artifacts)
  echo "   saved $name to dtw-artifacts"
}
restore_run() {  # name: bring a trained run back from dtw-artifacts instead of retraining it
  local name=$1 run=$W/runs/$1 f
  [ -f $run/heads.pt ] && return 0
  [ -d $ART/$name ] || return 1
  mkdir -p $run
  for f in $ART/$name/*; do
    case $f in
      *.part00) cat ${f%.part00}.part* > $run/$(basename ${f%.part00}) ;;
      *.part[0-9][0-9]) ;;
      *) cp $f $run/ ;;
    esac
  done
  echo "   restored $name from dtw-artifacts"
}
save_results() {
  git add $OUT && git commit -q -m "DtW results: $*$TRAILER" -- $OUT && push $R $BRANCH
}

# ---------- experiments ----------
export_run() {
  local run=$1
  $V research/dtw/model/export_heads.py $run > /dev/null
  [ -d $run/backbone ] && [ -f $run/backbone/config.json ] || return 0
  $V $L/convert_hf_to_gguf.py $run/backbone --outtype f16 --outfile $run/backbone-f16.gguf > $W/logs/convert-$(basename $run).log 2>&1
  $L/build/bin/llama-quantize $run/backbone-f16.gguf $run/backbone-q8_0.gguf Q8_0 > /dev/null 2>&1
  $L/build/bin/llama-quantize $run/backbone-f16.gguf $run/backbone-q4_0.gguf Q4_0 > /dev/null 2>&1
}
evaluate() {  # name args...; skipped if its result is already committed
  local name=$1; shift
  [ -f $OUT/$name.json ] && { echo "   $name already done"; return 0; }
  node ml/eval/run.mjs "$@" --threads 4 --name $name --out $OUT > $W/logs/$name.log 2>&1
  echo "   $name exit $? $(grep -o '"f1": [0-9.]*' $OUT/$name.json 2>/dev/null | head -1)"
  save_results $name
}
DTW="--provider module:research/dtw/runtime/dtw-provider.mjs"
dtw3() {  # name run [extra]
  local name=$1 run=$2; shift 2
  evaluate $name-bench $DTW --dtw-run $run "$@" --set bench --set-file $BENCH
  evaluate $name-gold $DTW --dtw-run $run "$@" --set gold
  evaluate $name-test-mini $DTW --dtw-run $run "$@" --set test-mini
}
train_enc() {  # name hf seed [extra]
  local name=$1 hf=$2 seed=$3; shift 3
  local run=$W/runs/$name-s$seed
  restore_run $name-s$seed; [ -f $run/heads.pt ] && { echo "   $name-s$seed already trained"; return 0; }
  (cd research/dtw/model && $V train_encoder.py --model $hf --train $W/train4k.spans.jsonl --val $W/val.spans.jsonl --out $run --epochs 2 --seed $seed --bs 16 "$@" > $W/logs/train-$name-s$seed.log 2>&1)
  echo "   train $name-s$seed exit $? $(grep -o 'done.*' $W/logs/train-$name-s$seed.log | head -c 300)"
  export_run $run; save_run $run
}

step "1 retrain Ettin-150M seed 1 (lost with the old container) and check it reproduces bench F1 0.306"
train_enc ettin150 jhu-clsp/ettin-encoder-150m 1
evaluate dtw-ettin150-s1r-bench $DTW --dtw-run $W/runs/ettin150-s1 --set bench --set-file $BENCH
step "2 LFM3 QAD prompt v2 on the benchmark (today's pipeline)"
evaluate lfm3-qad-v2-bench --provider local:lfm3-1.7b-qad-q4 --set bench --set-file $BENCH
step "3 decide-then-write + LFM3 writer"
evaluate dtw-ettin150-s1-writer-bench $DTW --dtw-run $W/runs/ettin150-s1 --dtw-writer lfm3 --set bench --set-file $BENCH

step "4 LFM3 frozen features (train 4000, val 400) and heads"
restore_run lfm3-heads-s1
if [ ! -f $W/runs/lfm3-heads-s1/heads.pt ]; then
  $L/build/bin/llama-server -m $LFM3 -c 4096 -ub 2048 -b 2048 -t 4 --port 18097 --embedding --pooling none > $W/logs/lfm3-emb.log 2>&1 &
  SRV=$!
  for i in $(seq 1 120); do curl -s localhost:18097/health | grep -q ok && break; sleep 1; done
  $V research/dtw/model/lfm3_features.py 18097 $W/train4k.spans.jsonl $W/lfm3-train > $W/logs/lfm3-feat-train.log 2>&1
  $V research/dtw/model/lfm3_features.py 18097 $W/val.spans.jsonl $W/lfm3-val 400 > $W/logs/lfm3-feat-val.log 2>&1
  kill $SRV; wait $SRV 2>/dev/null
  (cd research/dtw/model && $V train_lfm3_heads.py --train-feat $W/lfm3-train --train $W/train4k.spans.jsonl --val-feat $W/lfm3-val --val $W/val.spans.jsonl --out $W/runs/lfm3-heads-s1 > $W/logs/train-lfm3-heads-s1.log 2>&1)
  echo "   $(grep -o 'done.*' $W/logs/train-lfm3-heads-s1.log | head -c 300)"
  export_run $W/runs/lfm3-heads-s1; save_run $W/runs/lfm3-heads-s1
fi
step "5 LFM3 + attached classifiers"; dtw3 dtw-lfm3heads-s1 $W/runs/lfm3-heads-s1 --dtw-gguf $LFM3

step "6 mmBERT-base"; train_enc mmbert jhu-clsp/mmBERT-base 1 --freeze-embeddings; dtw3 dtw-mmbert-s1 $W/runs/mmbert-s1
step "7 Ettin-400M"; train_enc ettin400 jhu-clsp/ettin-encoder-400m 1; dtw3 dtw-ettin400-s1 $W/runs/ettin400-s1
step "8 Ettin-150M seeds 2 and 3"
for s in 2 3; do train_enc ettin150 jhu-clsp/ettin-encoder-150m $s; evaluate dtw-ettin150-s$s-bench $DTW --dtw-run $W/runs/ettin150-s$s --set bench --set-file $BENCH; done
step "all done"
