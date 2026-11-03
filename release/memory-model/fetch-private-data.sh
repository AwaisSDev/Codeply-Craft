#!/bin/bash
# Restore the WildChat-derived files that are kept out of the public repository (PRIVATE-DATA.md) to their
# original paths, from the private Kaggle dataset, and verify every file against PRIVATE-DATA-MANIFEST.json.
# Needs Kaggle credentials of an account the owner gave access (KAGGLE_USERNAME / KAGGLE_KEY or ~/.kaggle).
#   release/memory-model/fetch-private-data.sh            download + extract + verify
#   release/memory-model/fetch-private-data.sh --verify   only verify the files already in place
#   PRIVATE_DATA_DIR=/kaggle/input/codeply-memory-derived-data release/memory-model/fetch-private-data.sh   (no download)
set -euo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd); cd "$R"
MAN=release/memory-model/PRIVATE-DATA-MANIFEST.json
if [ "${1:-}" != "--verify" ]; then
  KAGGLE=${KAGGLE:-kaggle}
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  SRC=${PRIVATE_DATA_DIR:-}   # e.g. /kaggle/input/codeply-memory-derived-data inside a Kaggle notebook
  if [ -z "$SRC" ]; then "$KAGGLE" datasets download -d awaissididique/codeply-memory-derived-data -p "$T" --unzip -q; SRC=$T; fi
  # Kaggle unpacks the uploaded tar into derived-data/; a plain download of the tar is handled too.
  if [ -d "$SRC/derived-data" ]; then cp -a "$SRC/derived-data/." "$R/"; else tar -xf "$SRC/derived-data.tar" -C "$R"; fi
  # Kaggle decompresses .gz files: compress them back to the paths the scripts expect (content is verified below).
  python3 -I - "$MAN" <<'PY'
import gzip, json, os, shutil, sys
for f in json.load(open(sys.argv[1]))["files"]:
    if f.endswith(".gz") and not os.path.exists(f) and os.path.exists(f[:-3]):
        with open(f[:-3], "rb") as i, gzip.GzipFile(f, "wb", mtime=0) as o: shutil.copyfileobj(i, o)
        os.remove(f[:-3])
PY
fi
python3 -I - "$MAN" <<'PY'
import hashlib, json, os, sys
m = json.load(open(sys.argv[1]))["files"]
import gzip
def ok(f, v):
    if not os.path.exists(f): return False
    if hashlib.sha256(open(f, "rb").read()).hexdigest() == v["sha256"]: return True
    return f.endswith(".gz") and hashlib.sha256(gzip.open(f).read()).hexdigest() == v.get("sha256Uncompressed")
bad = [f for f, v in m.items() if not ok(f, v)]
print(f"{len(m) - len(bad)}/{len(m)} private files present and verified")
for f in bad[:20]: print("  missing or changed:", f)
sys.exit(1 if bad else 0)
PY
