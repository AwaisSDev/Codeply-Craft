#!/usr/bin/env bash
# (Re)create the two private Kaggle datasets the notebooks need, in WHATEVER Kaggle account the credentials belong to,
# from persistent storage (private HF repo Awais1290/paste-data, folder kaggle-trainval-v1/, sha256-verified):
#   * <user>/paste-trainval : train-mix-full.jsonl, val-programmatic.jsonl, val-api.jsonl, MANIFEST.json (train + val
#     only; the notebooks check every hash and refuse test/stress files)
#   * <user>/paste-hf-token : the HF token used by paste.backup inside notebooks
# Needs: KAGGLE_USERNAME, KAGGLE_KEY, HF_TOKEN in the environment. Nothing is written to the repository.
#   scripts/kaggle/make_datasets.sh [trainval] [token]      (default: both)
set -euo pipefail
cd "$(dirname "$0")/../.."
KAGGLE=${KAGGLE:-kaggle}; PY=${PY:-python}
what=${*:-trainval token}
if [[ " $what " == *" trainval "* ]]; then
  d=$(mktemp -d)
  HF_HUB_DISABLE_PROGRESS_BARS=1 $PY - "$d" <<'EOF'
import hashlib, json, os, shutil, sys
from huggingface_hub import hf_hub_download
d = sys.argv[1]
for f in ("MANIFEST.json", "train-mix-full.jsonl", "val-programmatic.jsonl", "val-api.jsonl"):
    shutil.copyfile(hf_hub_download("Awais1290/paste-data", f"kaggle-trainval-v1/{f}", repo_type="dataset"), os.path.join(d, f))
man = json.load(open(os.path.join(d, "MANIFEST.json")))
for f, h in man["sha256"].items():
    assert hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest() == h, f"{f}: hash mismatch"
    assert not any(x in f for x in ("test", "stress", "frozen"))
print("trainval bundle verified:", sorted(man["sha256"]))
EOF
  printf '{"title": "paste-trainval", "id": "%s/paste-trainval", "licenses": [{"name": "other"}]}\n' "$KAGGLE_USERNAME" > "$d/dataset-metadata.json"
  $KAGGLE datasets create -p "$d" | tail -1      # private unless --public is given
  rm -rf "$d"
fi
if [[ " $what " == *" token "* ]]; then
  d=$(mktemp -d); (umask 077; printf '%s' "$HF_TOKEN" > "$d/paste-hf-token")
  printf '{"title": "paste-hf-token", "id": "%s/paste-hf-token", "licenses": [{"name": "other"}]}\n' "$KAGGLE_USERNAME" > "$d/dataset-metadata.json"
  $KAGGLE datasets create -p "$d" | tail -1
  rm -rf "$d"
fi
echo "check privacy: $KAGGLE datasets list --mine (both must be private)"
