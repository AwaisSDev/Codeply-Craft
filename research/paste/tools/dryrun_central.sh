#!/usr/bin/env bash
# End-to-end dry run of the central-test procedure (CENTRAL-TEST-PLAN §3 steps 5-8) on VALIDATION stand-ins, in a
# scratch git repository: calibrate_full -> freeze -> commit -> guarded final_eval (+ guard refusals) ->
# bench_systems -> final_report. It never opens test or stress data: final_eval in dry-run mode refuses any file
# named test/stress and any data dir under "frozen"; the stand-ins are the first N episodes of the val files.
#   tools/dryrun_central.sh OUT_DIR NAME=SYSTEM_RUN_DIR...   (NAME e.g. PASTE-s1; system and seed from config.json)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$1; shift
PY=${PY:-python}; N=${N:-12}; CAL_LIMIT=${CAL_LIMIT:-10}; REPS=${REPS:-5}
DATA=${DATA:-$HOME/paste-data/train}
VAL="$DATA/val-programmatic.jsonl $DATA/api-val/val-api.jsonl"
rm -rf "$OUT"; mkdir -p "$OUT/repo/results/final" "$OUT/data" "$OUT/runs"
export PASTE_FINAL_DRYRUN_ROOT="$OUT/repo"
fail() { echo "DRYRUN FAIL: $*"; exit 1; }
expect_refusal() {  # cmd... ; must exit non-zero with the given message fragment
  local msg=$1; shift
  if out=$("$@" 2>&1); then fail "guard did not refuse: $*"; fi
  grep -q "$msg" <<<"$out" || fail "unexpected refusal text for $*: $out"
  echo "guard ok: $msg"
}

# 1. stand-in data + its own FROZEN.json, committed
head -n "$N" "$DATA/val-programmatic.jsonl" > "$OUT/data/dry-val-programmatic.jsonl"
head -n "$N" "$DATA/api-val/val-api.jsonl" > "$OUT/data/dry-val-api.jsonl"
$PY - "$OUT" <<'EOF'
import hashlib, json, sys
o = sys.argv[1]
files = {f: {"sha256": hashlib.sha256(open(f"{o}/data/{f}", "rb").read()).hexdigest()} for f in ("dry-val-programmatic.jsonl", "dry-val-api.jsonl")}
json.dump({"version": "dryrun", "files": files}, open(f"{o}/repo/results/FROZEN.json", "w"), indent=1)
EOF
git -C "$OUT/repo" init -q && git -C "$OUT/repo" add -A && git -C "$OUT/repo" -c user.name=dry -c user.email=dry@localhost commit -qm data

# 2. calibration (validation; small limit) + freeze, per run; run dirs are copies (config) + symlinked checkpoints
names=()
for spec in "$@"; do
  name=${spec%%=*}; src=${spec#*=}; d="$OUT/runs/$name"; mkdir -p "$d"
  cp "$src/config.json" "$d/"; ln -s "$(readlink -f "$src/final.pt")" "$d/final.pt"
  $PY -m paste.calibrate_full --run "$d" --val $VAL --limit "$CAL_LIMIT" --tf-limit 5 --threads 2 > "$d/cal.out" 2>&1 \
    || { tail -5 "$d/cal.out"; fail "calibrate_full $name"; }
  echo "calibrated $name: $(tail -1 "$d/cal.out")"
  [ "$name" = "${names[0]:-}" ] || true
  if [ ${#names[@]} -eq 0 ]; then   # guard: evaluation before FROZEN-RUNS exists / is committed
    expect_refusal "must be committed" $PY -m paste.final_eval --run-name "$name" --ckpt "$d/final.pt" --data-dir "$OUT/data" --files dry-val-api.jsonl
  fi
  $PY -m paste.final_eval --freeze --run-name "$name" --run-dir "$d" >/dev/null
  names+=("$name")
done
expect_refusal "must be committed" $PY -m paste.final_eval --run-name "${names[0]}" --ckpt "$OUT/runs/${names[0]}/final.pt" --data-dir "$OUT/data" --files dry-val-api.jsonl
expect_refusal "already frozen" $PY -m paste.final_eval --freeze --run-name "${names[0]}" --run-dir "$OUT/runs/${names[0]}"
git -C "$OUT/repo" add -A && git -C "$OUT/repo" -c user.name=dry -c user.email=dry@localhost commit -qm freeze

# 3. guarded evaluation + refusals
first=${names[0]}; other=${names[1]:-}
expect_refusal "not a frozen file" $PY -m paste.final_eval --run-name "$first" --ckpt "$OUT/runs/$first/final.pt" --data-dir "$OUT/data" --files val-other.jsonl
expect_refusal "validation stand-ins only" $PY -m paste.final_eval --run-name "$first" --ckpt "$OUT/runs/$first/final.pt" --data-dir "$OUT/data" --files test-api.jsonl
[ -n "$other" ] && expect_refusal "checkpoint hash differs" $PY -m paste.final_eval --run-name "$first" --ckpt "$OUT/runs/$other/final.pt" --data-dir "$OUT/data" --files dry-val-api.jsonl
cp "$OUT/data/dry-val-api.jsonl" "$OUT/data-mod.jsonl"; head -n 1 "$OUT/data/dry-val-api.jsonl" >> "$OUT/data/dry-val-api.jsonl"
expect_refusal "data hash differs" $PY -m paste.final_eval --run-name "$first" --ckpt "$OUT/runs/$first/final.pt" --data-dir "$OUT/data" --files dry-val-api.jsonl
mv "$OUT/data-mod.jsonl" "$OUT/data/dry-val-api.jsonl"
for name in "${names[@]}"; do
  $PY -m paste.final_eval --run-name "$name" --ckpt "$OUT/runs/$name/final.pt" --data-dir "$OUT/data" \
    --files dry-val-programmatic.jsonl dry-val-api.jsonl --threads 2 | tail -2
done
expect_refusal "already evaluated" $PY -m paste.final_eval --run-name "$first" --ckpt "$OUT/runs/$first/final.pt" --data-dir "$OUT/data" --files dry-val-api.jsonl
$PY -m paste.final_eval --run-name "$first" --ckpt "$OUT/runs/$first/final.pt" --data-dir "$OUT/data" --files dry-val-api.jsonl \
  --rerun-reason "dry-run check of the deviation path" --threads 2 >/dev/null
grep -q "DEVIATION rerun" "$OUT/repo/results/final/ACCESS-LOG.md" || fail "rerun not logged as deviation"
echo "guard ok: rerun logged as deviation"

# 4. latency (smoke: few reps, machine not quiet) and 5. report
runs=(); for name in "${names[@]}"; do runs+=("${name%-s*}=$OUT/runs/$name"); done
$PY tools/bench_systems.py --runs "${runs[@]}" --reps "$REPS" --threads 2 --out "$OUT/lat.json" | grep '"K": 32' | head -1
$PY -m paste.final_report --files dry-val-programmatic.jsonl dry-val-api.jsonl --latency "$OUT/lat.json" --n-boot 1000 \
  --out "$OUT/report.json" > "$OUT/report.out"
$PY -c "import json,sys; r=json.load(open(sys.argv[1])); print('outcome:', r.get('outcome')); print(json.dumps(r['systems']))" "$OUT/report.json"
echo "DRYRUN OK"
