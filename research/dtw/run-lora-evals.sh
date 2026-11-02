#!/bin/bash
# Evaluation of the realistic-data LFM3-1.7B LoRA runs (Kaggle LoRA run 4, exported by codeply-real-lfm3-export)
# on test-real, Benchmark-520 and natural-300, plus untrained LFM3 Q4_K_M on test-real as the
# same-quantisation baseline (the production baseline lfm3-qad-v2-* is QAD Q4_0).
# The merged-and-quantized export did not fit Kaggle's limits (KAGGLE-RUNS.md), so each run's LoRA adapter is
# converted to GGUF (llama.cpp convert_lora_to_gguf.py, f16) and applied at load time (llama-server --lora) on
# the same LFM3 Q4_K_M base file as the untrained baseline lfm3-q4-v2-test-real, with the runtime settings of
# the LFM3 catalog entry (thinking off, --swa-full, ctx 8192). Resumable: a result that exists is skipped.
# Usage: W=<scratch> G=<dir with real-lfm3-lora-s{1,2}-lora-f16.gguf> research/dtw/run-lora-evals.sh
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
  # Warm the page cache: after a container restart the first server start can exceed the runtime's 90 s
  # start timeout while it reads the 1 GB base file and the adapter (seed 1's first try failed that way).
  cat ~/.codeply/models/LFM3-1.7B-Q4_K_M.gguf $G/*.gguf > /dev/null 2>&1
  node ml/eval/run.mjs --provider $prov --set $set --set-file ${SETFILE[$set]} --threads 4 --name $name --out $OUT > $W/logs/$name.log 2>&1
  echo "   $name exit $? $(grep -o '"f1": [0-9.]*' $OUT/$name.json 2>/dev/null | head -1)"
  git pull -q --rebase origin $BRANCH; git add $OUT && git commit -q -m "DtW results: $name$TRAILER" -- $OUT && push
}
register() {  # id lora-gguf: the LFM3 Q4_K_M base file + the run's LoRA applied at load time (llama-server --lora)
  node -e "
    const fs=require('fs'),path=require('path');
    const RT=require('./codeply-cli/lib/local-runtime.js'); const base=RT.CATALOG['lfm3-1.7b-q4'];
    const f=path.join(RT.MODELS_DIR(),'manifest.json'); const m=JSON.parse(fs.readFileSync(f,'utf8'));
    const b=m.find((e)=>e.id==='lfm3-1.7b-q4'); if(!b){console.error('base lfm3-1.7b-q4 not installed');process.exit(1);}
    const entry={id:'$1',file:b.file,sha256:b.sha256,bytes:b.bytes,license:'LFM Open License v1.0 (base) + LoRA trained on the frozen realistic split',
      ctx:base.ctx,extra:base.extra,serverArgs:[...base.serverArgs,'--lora',path.resolve('$2')],arch:base.arch,params:base.params,addedAt:new Date().toISOString()};
    const out=m.filter((e)=>e.id!=='$1'); out.push(entry); fs.writeFileSync(f,JSON.stringify(out,null,2)+'\\n');
    console.log('registered $1:',JSON.stringify({file:entry.file,serverArgs:entry.serverArgs,extra:entry.extra,ctx:entry.ctx}));"
}
for s in 1 2; do
  g=$(ls $G/real-lfm3-lora-s$s-lora-*.gguf 2>/dev/null | head -1)
  [ -n "$g" ] || { echo "   no LoRA GGUF for seed $s"; continue; }
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
