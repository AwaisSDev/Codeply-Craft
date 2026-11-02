#!/bin/bash
# Evaluation of the realistic-data LFM3-1.7B LoRA runs (Kaggle LoRA run 4, exported by codeply-real-lfm3-export)
# on test-real, Benchmark-520 and natural-300, plus untrained LFM3 Q4_K_M on test-real as the
# same-quantisation baseline (the production baseline lfm3-qad-v2-* is QAD Q4_0).
# Each fine-tuned GGUF is registered for the local runtime by symlink (scripts/context/fetch-model.mjs --from)
# with the runtime settings of the LFM3 catalog entry (thinking off, --swa-full, ctx 8192). Resumable: a
# result that exists is skipped, so after a container restart the script can simply be run again.
# Usage: W=<scratch> G=<dir with real-lfm3-lora-s{1,2}/*Q4_K_M.gguf> research/dtw/run-lora-evals.sh
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); cd $R
W=${W:?set W}; G=${G:?set G}; mkdir -p $W/logs
BRANCH=$(git rev-parse --abbrev-ref HEAD)
OUT=research/dtw/results
TRAILER=$'\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01MFYAyHbBeH3UFEVYbSzRXQ'
declare -A SETFILE=([test-real]=research/dtw/data/real/test.jsonl [bench]=research/dtw/benchmark/bench.jsonl [natural]=research/dtw/label/data/fullnat.jsonl)
push() { for d in 2 4 8 16; do git push -q -u origin $BRANCH && return 0; sleep $d; done; echo "   push failed"; }
evaluate() {  # name provider set
  local name=$1 prov=$2 set=$3
  [ -f $OUT/$name.json ] && { echo "   $name already done"; return 0; }
  echo "== $(date -u +%T) $name"
  node ml/eval/run.mjs --provider $prov --set $set --set-file ${SETFILE[$set]} --threads 4 --name $name --out $OUT > $W/logs/$name.log 2>&1
  echo "   $name exit $? $(grep -o '"f1": [0-9.]*' $OUT/$name.json 2>/dev/null | head -1)"
  git pull -q --rebase origin $BRANCH; git add $OUT && git commit -q -m "DtW results: $name$TRAILER" -- $OUT && push
}
register() {  # id gguf
  node -e "const RT=require('./codeply-cli/lib/local-runtime.js'); process.exit(RT.models().some((m)=>m.id==='$1')?0:1)" 2>/dev/null && return 0
  node scripts/context/fetch-model.mjs $1 --from $2 --license "LFM Open License v1.0 (fine-tuned)" || return 1
  node -e "
    const fs=require('fs'),path=require('path');
    const RT=require('./codeply-cli/lib/local-runtime.js'); const base=RT.CATALOG['lfm3-1.7b-q4'];
    const f=path.join(RT.MODELS_DIR(),'manifest.json');
    const m=JSON.parse(fs.readFileSync(f,'utf8'));
    for (const e of m) if (e.id==='$1') Object.assign(e,{ctx:base.ctx,extra:base.extra,serverArgs:base.serverArgs,arch:base.arch,params:base.params});
    fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n'); console.log('registered $1 with',JSON.stringify({ctx:base.ctx,extra:base.extra,serverArgs:base.serverArgs}));"
}
for s in 1 2; do
  g=$(ls $G/real-lfm3-lora-s$s/*Q4_K_M.gguf 2>/dev/null | head -1)
  [ -n "$g" ] || { echo "   no GGUF for seed $s"; continue; }
  register codeply-real-lfm3-lora-s$s $g || { echo "   could not register seed $s"; continue; }
done
for set in test-real bench natural; do
  for s in 1 2; do
    node -e "const RT=require('./codeply-cli/lib/local-runtime.js'); process.exit(RT.models().some((m)=>m.id==='codeply-real-lfm3-lora-s$s')?0:1)" 2>/dev/null || continue
    evaluate real-lfm3-lora-s$s-$set local:codeply-real-lfm3-lora-s$s $set
  done
  [ $set = test-real ] && evaluate lfm3-q4-v2-test-real local:lfm3-1.7b-q4 test-real
done
echo "== all done"
