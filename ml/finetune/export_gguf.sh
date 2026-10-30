#!/usr/bin/env bash
# Merged fine-tuned weights -> GGUF -> INT4 (Q4_K_M) and INT8 (Q8_0), with an
# importance matrix computed on the validation prompts (better INT4 quality
# for this task than a generic one), then registered for the local runtime.
#
#   ml/finetune/export_gguf.sh ml/finetune/runs/codeply-context-v1/merged codeply-context-v1
#
# Needs a llama.cpp checkout at $LLAMA_CPP (default ~/llama.cpp) built with
# llama-quantize and llama-imatrix, and its Python requirements
# (pip install -r $LLAMA_CPP/requirements/requirements-convert_hf_to_gguf.txt).
set -euo pipefail
MERGED="${1:?merged model folder}"
NAME="${2:-codeply-context-v1}"
LLAMA_CPP="${LLAMA_CPP:-$HOME/llama.cpp}"
OUT="${OUT:-$(dirname "$MERGED")/gguf}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$OUT"

python "$LLAMA_CPP/convert_hf_to_gguf.py" "$MERGED" --outtype f16 --outfile "$OUT/$NAME-f16.gguf"

# Calibration text: the runtime prompts of the validation set (what the model will really read).
node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").slice(0, 300);
fs.writeFileSync(process.argv[2], rows.map((l) => JSON.parse(l).messages.map((m) => m.content).join("\n")).join("\n\n"));
' "$ROOT/ml/data/out/sft-val.jsonl" "$OUT/calibration.txt"
"$LLAMA_CPP/build/bin/llama-imatrix" -m "$OUT/$NAME-f16.gguf" -f "$OUT/calibration.txt" -o "$OUT/imatrix.dat" -c 2048 --chunks "${IMATRIX_CHUNKS:-200}"

"$LLAMA_CPP/build/bin/llama-quantize" --imatrix "$OUT/imatrix.dat" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-Q4_K_M.gguf" Q4_K_M
"$LLAMA_CPP/build/bin/llama-quantize" "$OUT/$NAME-f16.gguf" "$OUT/$NAME-Q8_0.gguf" Q8_0
ls -la "$OUT"
echo "Register it:   node scripts/context/fetch-model.mjs $NAME --from $OUT/$NAME-Q4_K_M.gguf"
echo "Evaluate it:   node ml/eval/run.mjs --provider local:$NAME --set test --style compact && node ml/finetune/gate.mjs ml/results/local_$NAME-test-compact.json"
