#!/bin/bash
# Release evaluation of an exported memory model (production artifact), resumable; one job at a time:
#   1. register the exported Q4_K_M for the local runtime (manifest entry, production settings: full prompt,
#      thinking off, --swa-full, ctx 8192)
#   2. the confidence provider (production backend + token log-probabilities; answers identical to production)
#      on val, test-real and Benchmark-520, in chunks of 50 -> release/memory-model/results/
#      = the post-export evaluation (task 3) and the data for the tier selection (TIERS.md, val only)
#   3. the integration suite (50 live cases) on the same model
# Each result is committed and pushed as it lands.
# Usage: W=<work dir> release/memory-model/run-release-evals.sh <seed> <exported Q4_K_M gguf>
set -u
R=$(cd "$(dirname "$0")/../.." && pwd); cd "$R"
SEED=${1:?seed}; GGUF=$(readlink -f "${2:?gguf}"); W=${W:?work dir}
ID=codeply-memory-lfm3-s$SEED-q4
OUT=release/memory-model/results
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TRAILER=$'\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01MFYAyHbBeH3UFEVYbSzRXQ'
declare -A SETFILE=([val]=research/dtw/data/real/val.jsonl [test-real]=research/dtw/data/real/test.jsonl [bench]=research/dtw/benchmark/bench.jsonl)
mkdir -p "$W/logs" "$OUT"
push() { for d in 2 4 8 16; do git push -q -u origin "$BRANCH" && return 0; sleep $d; done; echo "   push failed"; }
commit() { git pull -q --rebase origin "$BRANCH"; git add "$OUT" && git commit -q -m "Memory model release: $*$TRAILER" -- "$OUT" && push; }

# 1. register (idempotent)
node -e "
  const fs=require('fs'),path=require('path'),RT=require('./codeply-cli/lib/local-runtime.js');
  const base=RT.CATALOG['lfm3-1.7b-q4']; const f=path.join(RT.MODELS_DIR(),'manifest.json');
  const m=JSON.parse(fs.readFileSync(f,'utf8')).filter((e)=>e.id!=='$ID');
  m.push({id:'$ID',file:'$GGUF',license:'LFM Open License v1.0 (base); fine-tuned',ctx:base.ctx,extra:base.extra,serverArgs:base.serverArgs,style:'full',arch:base.arch+', LoRA fine-tune merged, Q4_K_M imatrix',params:base.params,addedAt:new Date().toISOString()});
  fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n'); console.log('registered $ID ->', '$GGUF');"

# 2. confidence runs (val first: the tier selection reads only val)
for set in val test-real bench; do
  name=release-s$SEED-$set
  [ -f "$OUT/$name.json" ] && { echo "   $name done"; continue; }
  echo "== $(date -u +%T) $name"
  cat "$GGUF" > /dev/null  # warm the page cache (cold start vs the runtime's 90 s start timeout)
  python3 research/dtw/run-chunked-eval.py --name "$name" --provider module:release/memory-model/conf-provider.mjs \
    --extra "--conf-model $ID" --set "$set" --set-file "${SETFILE[$set]}" --work "$W/chunks" --chunk 50 --out "$OUT" >> "$W/logs/$name.log" 2>&1
  echo "   $name exit $? $(grep -o '"f1": [0-9.]*' "$OUT/$name.json" 2>/dev/null | head -1)"
  commit "$name"
done

# 3. integration suite (live)
if [ ! -f "$OUT/integration-s$SEED.json" ]; then
  echo "== $(date -u +%T) integration suite"
  node release/memory-model/integration/run-integration.mjs --model "$ID" --threads 4 --out "$OUT/integration-s$SEED.json" > "$W/logs/integration-s$SEED.log" 2>&1
  echo "   integration exit $?"; tail -14 "$W/logs/integration-s$SEED.log"
  commit "integration suite, seed $SEED"
fi
echo "== all done"
