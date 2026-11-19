#!/usr/bin/env bash
# Wave A of the foundation study (EVAL-PLAN §3, §4, amendment A1). NOT RUN YET: awaiting the owner's approval.
#
# Needs: llama-server from llama.cpp 7a4117eef97e (IRIS_LLAMA_SERVER), the GGUFs in $MODELS with the sha256 in
# stage0/bench/GGUF-SHA256SUMS. Validation only; the test split is never touched. ~12 CPU-hours on the reference
# container (stage0/bench.json), sequential. Every run writes preds-*.jsonl (resumable cache), result-*.json and
# MANIFEST-*.json under results/foundation-2026-11/<system>/, then report_run.py writes foundation-report-val.json.
set -euo pipefail
cd "$(dirname "$0")/.."                                  # research/iris
: "${IRIS_LLAMA_SERVER:?set IRIS_LLAMA_SERVER to the pinned llama-server}"
: "${MODELS:?set MODELS to the GGUF directory}"
(cd "$MODELS" && sha256sum -c "$OLDPWD/foundation-2026-11/stage0/bench/GGUF-SHA256SUMS")

OFF='{"enable_thinking": false}'
run() {   # name gguf template-kwargs prompt-version
  local name=$1 gguf=$2 kw=$3 pv=$4 out=results/foundation-2026-11/$1
  local common=(--system zeroshot --model "$MODELS/$gguf" --chat --prompt-version "$pv" --threads 4 --split val)
  [ -n "$kw" ] && common+=(--template-kwargs "$kw")
  python3 -m codeply_iris.evaluate "${common[@]}" --constrain --out "$out"                    # open loop, constrained
  python3 -m codeply_iris.evaluate "${common[@]}" --constrain --closed-loop --out "$out"      # closed loop, constrained
  python3 -m codeply_iris.evaluate "${common[@]}" --limit 6 --out "$out-unconstrained"       # secondary: native format
  python3 foundation-2026-11/report_run.py "$out"
  python3 foundation-2026-11/report_run.py "$out" --exclude-episode va01-e01                # sensitivity (EVAL-PLAN §2)
  python3 foundation-2026-11/report_run.py "$out-unconstrained"
}

run_v1() {   # continuity only: prompt v1, open loop, constrained (measures what the v1.1 sentence changes)
  local out=results/foundation-2026-11/$1-v1
  python3 -m codeply_iris.evaluate --system zeroshot --model "$MODELS/$2" --chat --prompt-version v1 --threads 4 \
      --split val --template-kwargs "$OFF" --constrain --out "$out"
  python3 foundation-2026-11/report_run.py "$out"
}

# baselines, prompt v1.1 (primary), then v1 (continuity with the only earlier zero-shot result)
run qwen3-0.6b      Qwen3-0.6B-Q4_K_M.gguf               "$OFF" v1.1
run qwen3-1.7b      Qwen3-1.7B-Q4_K_M.gguf               "$OFF" v1.1
run_v1 qwen3-0.6b   Qwen3-0.6B-Q4_K_M.gguf
run_v1 qwen3-1.7b   Qwen3-1.7B-Q4_K_M.gguf
# candidates
run qwen3.5-2b      Qwen3.5-2B-Q4_K_M.gguf               "$OFF" v1.1
run gemma-4-e2b     gemma-4-E2B_q4_0-it.gguf             "$OFF" v1.1
run qwen3-4b-2507   Qwen3-4B-Instruct-2507-Q4_K_M.gguf   ""     v1.1     # non-thinking only: no switch
