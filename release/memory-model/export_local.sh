#!/bin/bash
# Production export of a trained LFM3 LoRA run on a CPU machine, resumable step by step:
#   1. llama.cpp tools (llama-quantize, llama-imatrix) at the pinned commit
#   2. calibration prompts = the frozen realistic val split rendered as the production prompt (sft-val.jsonl)
#   3. merge (release/memory-model/merge_adapter.py: as ml/finetune/train_lora.py does)
#   4. the commands of ml/finetune/export_gguf.sh, verbatim: f16 GGUF, importance matrix (200 chunks), Q4_K_M, Q8_0
#   5. checksums; the merged weights and the f16 GGUF are deleted afterwards (disk)
# IMATRIX_ARGS: extra llama-imatrix flags, e.g. "-ngl 99" with a CUDA build (as export_gguf.sh).
# Usage: W=<work dir> LLAMA_SRC=<llama.cpp checkout at the pinned commit> PY=<python with torch/peft/transformers>
#        release/memory-model/export_local.sh <seed> <adapter_dir>
set -euo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd); cd "$R"
SEED=${1:?seed}; ADAPTER=${2:?adapter dir}
W=${W:?work dir}; LLAMA_SRC=${LLAMA_SRC:?llama.cpp source}; PY=${PY:-python3}
LLAMA_COMMIT=aa588a3463357ee990b314f41dda242869130704
NAME=codeply-memory-lfm3-s$SEED
D=$W/export/s$SEED; mkdir -p "$D"
log() { echo "== $(date -u +%T) s$SEED $*"; }

# 1. tools
if [ ! -x "$LLAMA_SRC/build/bin/llama-imatrix" ] || [ ! -x "$LLAMA_SRC/build/bin/llama-quantize" ]; then
  log "build llama.cpp tools"
  [ "$(git -C "$LLAMA_SRC" rev-parse HEAD)" = "$LLAMA_COMMIT" ] || { echo "llama.cpp is not at $LLAMA_COMMIT"; exit 1; }
  cmake -S "$LLAMA_SRC" -B "$LLAMA_SRC/build" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF > /dev/null
  cmake --build "$LLAMA_SRC/build" -j4 --target llama-quantize llama-imatrix > /dev/null
fi

# 2. calibration prompts (export_gguf.sh reads ml/data/out/sft-val.jsonl; not tracked)
if [ ! -s ml/data/out/sft-val.jsonl ]; then
  log "calibration prompts"
  mkdir -p "$W/sft" && cp research/dtw/data/real/train.jsonl research/dtw/data/real/val.jsonl "$W/sft/"
  node ml/data/export-sft.mjs --in "$W/sft" --style full
  cp "$W/sft/sft-val.jsonl" ml/data/out/sft-val.jsonl
fi

# 3-4. merge, then the commands of ml/finetune/export_gguf.sh (lines 19-31) verbatim, each written to a
# temporary name and renamed when it succeeds, so that a restart resumes at the step it was in.
LL="$LLAMA_SRC/build/bin"
if [ ! -s "$D/$NAME-f16.gguf" ]; then
  log "merge"
  "$PY" release/memory-model/merge_adapter.py "$ADAPTER" "$D/merged"
  log "convert to f16 GGUF"
  "$PY" "$LLAMA_SRC/convert_hf_to_gguf.py" "$D/merged" --outtype f16 --outfile "$D/$NAME-f16.gguf.part"
  mv "$D/$NAME-f16.gguf.part" "$D/$NAME-f16.gguf"
fi
rm -rf "$D/merged"
if [ ! -s "$D/imatrix.dat" ]; then
  log "importance matrix (200 chunks of the realistic val prompts)"
  node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").slice(0, 300);
fs.writeFileSync(process.argv[2], rows.map((l) => JSON.parse(l).messages.map((m) => m.content).join("\n")).join("\n\n"));
' ml/data/out/sft-val.jsonl "$D/calibration.txt"
  "$LL/llama-imatrix" -m "$D/$NAME-f16.gguf" -f "$D/calibration.txt" -o "$D/imatrix.dat.part" -c 2048 --chunks "${IMATRIX_CHUNKS:-200}" ${IMATRIX_ARGS:-}
  mv "$D/imatrix.dat.part" "$D/imatrix.dat"
fi
for q in Q4_K_M Q8_0; do
  [ -s "$D/$NAME-$q.gguf" ] && continue
  log "quantize $q"
  if [ $q = Q4_K_M ]; then "$LL/llama-quantize" --imatrix "$D/imatrix.dat" "$D/$NAME-f16.gguf" "$D/$NAME-$q.gguf.part" $q
  else "$LL/llama-quantize" "$D/$NAME-f16.gguf" "$D/$NAME-$q.gguf.part" $q; fi
  mv "$D/$NAME-$q.gguf.part" "$D/$NAME-$q.gguf"
done
# 5. checksums, cleanup
rm -f "$D/$NAME-f16.gguf"
(cd "$D" && sha256sum "$NAME"-Q4_K_M.gguf "$NAME"-Q8_0.gguf 2>/dev/null > SHA256SUMS)
log "done"; cat "$D/SHA256SUMS"
