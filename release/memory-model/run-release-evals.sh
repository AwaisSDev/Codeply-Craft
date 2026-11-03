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

# 1b. parity: does asking for log-probabilities change the answers? (same model, same threads, 8 examples with
#     memories). If it does, the headline post-export numbers come from the plain production backend (step 2b).
PAR=$OUT/logprobs-parity-s$SEED.json
if [ ! -f "$PAR" ]; then
  echo "== $(date -u +%T) logprobs parity"
  cat "$GGUF" > /dev/null  # warm the page cache: the plain backend has the runtime's 90 s start timeout
  python3 - "$W/par.jsonl" <<'PY'
import json, sys
rows = [l for l in open("research/dtw/data/real/val.jsonl") if any(o["certainty"] in ("stated", "implied", "temporary") for o in json.loads(l)["target"]["observations"])][:8]
open(sys.argv[1], "w").write("".join(rows))
PY
  rm -rf "$W/par"; mkdir -p "$W/par"
  node ml/eval/run.mjs --provider "local:$ID" --set val --set-file "$W/par.jsonl" --threads 4 --name plain --out "$W/par" > "$W/logs/par-plain.log" 2>&1
  node ml/eval/run.mjs --provider module:release/memory-model/conf-provider.mjs --conf-model "$ID" --set val --set-file "$W/par.jsonl" --threads 4 --name conf --out "$W/par" > "$W/logs/par-conf.log" 2>&1
  python3 - "$W/par" "$PAR" <<'PY'
import json, sys
d, out = sys.argv[1], sys.argv[2]
load = lambda n: {json.loads(l)["id"]: json.loads(l) for l in open(f"{d}/details/{n}.jsonl")}
strip = lambda raw: [{k: v for k, v in o.items() if k != "p"} for o in json.loads(raw)["observations"]]
a, b = load("plain"), load("conf")
same = [i for i in a if strip(a[i]["raw"]) == strip(b[i]["raw"])]
json.dump({"examples": len(a), "identical": len(same), "differ": sorted(set(a) - set(same))}, open(out, "w"), indent=1)
print(f"   parity: {len(same)}/{len(a)} identical")
PY
  commit "logprobs parity, seed $SEED"
fi
PLAIN=$(python3 -c "import json; r=json.load(open('$PAR')); print('yes' if r['identical'] < r['examples'] else 'no')")

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

# 2b. only if log-probabilities changed answers: the plain production backend on the primary sets
if [ "$PLAIN" = yes ]; then
  for set in test-real bench; do
    name=release-s$SEED-plain-$set
    [ -f "$OUT/$name.json" ] && continue
    echo "== $(date -u +%T) $name (plain production backend)"
    python3 research/dtw/run-chunked-eval.py --name "$name" --provider "local:$ID" --set "$set" --set-file "${SETFILE[$set]}" --work "$W/chunks" --chunk 50 --out "$OUT" >> "$W/logs/$name.log" 2>&1
    echo "   $name exit $? $(grep -o '"f1": [0-9.]*' "$OUT/$name.json" 2>/dev/null | head -1)"
    commit "$name"
  done
fi

# 3. integration suite (live)
if [ ! -f "$OUT/integration-s$SEED.json" ]; then
  echo "== $(date -u +%T) integration suite"
  node release/memory-model/integration/run-integration.mjs --model "$ID" --threads 4 --out "$OUT/integration-s$SEED.json" > "$W/logs/integration-s$SEED.log" 2>&1
  echo "   integration exit $?"; tail -14 "$W/logs/integration-s$SEED.log"
  commit "integration suite, seed $SEED"
fi
echo "== all done"
