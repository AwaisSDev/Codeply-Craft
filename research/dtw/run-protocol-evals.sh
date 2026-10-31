#!/bin/bash
# CPU evaluations required by MODEL-SELECTION-PROTOCOL.md that need no training here:
#   * the realistic-data Ettin-150M seeds 1-3 (trained on Kaggle, run 3) on Benchmark-520,
#     test-real and natural-300;
#   * the template-trained Ettin-150M (s1r) again with the corrected resolver (18e1d232),
#     saved under new names (suffix -r2) so the old-resolver results stay;
#   * untrained LFM3 QAD prompt v2 on test-real (the pending production baseline);
#   * the realistic-data Ettin-400M seed 1 (Kaggle run 4) on the same three sets.
# One job at a time on 4 cores. Each result is committed and pushed as it lands; the
# trained runs are first saved to the orphan branch dtw-artifacts (files > 90 MB split).
# Usage: W=<scratch> RUNS=<dir with real-ettin150-s{1,2,3}> research/dtw/run-protocol-evals.sh
set -u
R=$(cd "$(dirname "$0")/../.." && pwd)
W=${W:?set W}; RUNS=${RUNS:?set RUNS}
BRANCH=$(git -C $R rev-parse --abbrev-ref HEAD)
OUT=research/dtw/results
BENCH=research/dtw/benchmark/bench.jsonl
TEST=research/dtw/data/real/test.jsonl
NAT=research/dtw/label/data/fullnat.jsonl
DTW="--provider module:research/dtw/runtime/dtw-provider.mjs"
TRAILER=$'\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01MFYAyHbBeH3UFEVYbSzRXQ'
cd $R; mkdir -p $W/logs
step() { echo "== $(date +%T) $*"; }
push() { for d in 2 4 8 16; do git -C "$1" push -q -u origin "$2" && return 0; sleep $d; done; echo "   push of $2 failed"; }
save_results() { git pull -q --rebase origin $BRANCH; git add $OUT && git commit -q -m "DtW results: $*$TRAILER" -- $OUT && push $R $BRANCH; }
evaluate() {  # name args...; skipped if already committed
  local name=$1; shift
  [ -f $OUT/$name.json ] && { echo "   $name already done"; return 0; }
  node ml/eval/run.mjs "$@" --threads 4 --name $name --out $OUT > $W/logs/$name.log 2>&1
  echo "   $name exit $? $(grep -o '"f1": [0-9.]*' $OUT/$name.json 2>/dev/null | head -1)"
  save_results $name
}

step "0 save the realistic runs to dtw-artifacts"
ART=$W/artifacts
if [ ! -e $ART/.git ]; then git fetch -q origin dtw-artifacts && git worktree add -q -B dtw-artifacts $ART origin/dtw-artifacts; fi
for name in real-ettin150-s1 real-ettin150-s2 real-ettin150-s3 real-ettin400-s1; do
  src=$RUNS/$name; [ -d $src ] || continue
  [ -d $ART/$name ] && { echo "   $name already saved"; continue; }
  mkdir -p $ART/$name
  for f in heads.bin heads.json config.json train-log.jsonl backbone-q8_0.gguf backbone-q4_0.gguf; do
    [ -f $src/$f ] || continue
    if [ $(stat -c %s $src/$f) -gt 94371840 ]; then split -b 90m -d $src/$f $ART/$name/$f.part; else cp $src/$f $ART/$name/; fi
  done
  (cd $ART && git add -A $name && git commit -q -m "DtW artifacts: $name (realistic data, Kaggle)$TRAILER" && push $ART dtw-artifacts)
  echo "   saved $name"
done

step "1 realistic Ettin-150M seeds 1-3"
for s in 1 2 3; do
  run=$RUNS/real-ettin150-s$s
  evaluate dtw-real-ettin150-s$s-bench $DTW --dtw-run $run --set bench --set-file $BENCH
  evaluate dtw-real-ettin150-s$s-test-real $DTW --dtw-run $run --set test-real --set-file $TEST
  evaluate dtw-real-ettin150-s$s-natural $DTW --dtw-run $run --set natural --set-file $NAT
done

step "2 template Ettin-150M s1r with the corrected resolver"
T=$W/runs/ettin150-s1r
if [ ! -f $T/heads.json ]; then
  mkdir -p $T
  for f in $ART/ettin150-s1/*; do
    case $f in *.part00) cat ${f%.part00}.part* > $T/$(basename ${f%.part00}) ;; *.part[0-9][0-9]) ;; *) cp $f $T/ ;; esac
  done
fi
evaluate dtw-ettin150-s1r-r2-bench $DTW --dtw-run $T --set bench --set-file $BENCH
evaluate dtw-ettin150-s1r-r2-test-real $DTW --dtw-run $T --set test-real --set-file $TEST
evaluate dtw-ettin150-s1r-r2-natural $DTW --dtw-run $T --set natural --set-file $NAT

step "3 LFM3 QAD prompt v2 on test-real (production baseline, ~1.7 h)"
evaluate lfm3-qad-v2-test-real --provider local:lfm3-1.7b-qad-q4 --set test-real --set-file $TEST
step "4 realistic Ettin-400M seed 1"
run=$RUNS/real-ettin400-s1
evaluate dtw-real-ettin400-s1-bench $DTW --dtw-run $run --set bench --set-file $BENCH
evaluate dtw-real-ettin400-s1-test-real $DTW --dtw-run $run --set test-real --set-file $TEST
evaluate dtw-real-ettin400-s1-natural $DTW --dtw-run $run --set natural --set-file $NAT
step "all done"
