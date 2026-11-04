#!/usr/bin/env bash
# Push one generated notebook as a PRIVATE Kaggle kernel with the private paste-trainval dataset attached.
#   [KERNEL_SOURCES=owner/slug] scripts/kaggle/push.sh NOTEBOOK.ipynb SLUG gpu|cpu
# Credentials come from the environment (KAGGLE_USERNAME / KAGGLE_KEY); nothing is written to the repo.
set -euo pipefail
nbf=$1; slug=$2; acc=$3
d=$(mktemp -d); cp "$nbf" "$d/$slug.ipynb"
gpu=false; [ "$acc" = gpu ] && gpu=true
# KERNEL_SOURCES="owner/slug[,owner/slug]": attach earlier kernels' outputs (resume a time-guarded run)
ks=$(echo "${KERNEL_SOURCES:-}" | awk -F, '{for(i=1;i<=NF;i++) printf "%s\"%s\"", (i>1?", ":""), $i}')
cat > "$d/kernel-metadata.json" <<JSON
{"id": "$KAGGLE_USERNAME/$slug", "title": "$slug", "code_file": "$slug.ipynb", "language": "python",
 "kernel_type": "notebook", "is_private": true, "enable_gpu": $gpu, "enable_internet": true,
 "dataset_sources": ["$KAGGLE_USERNAME/paste-trainval"], "competition_sources": [], "kernel_sources": [$ks]}
JSON
${KAGGLE:-kaggle} kernels push -p "$d"
