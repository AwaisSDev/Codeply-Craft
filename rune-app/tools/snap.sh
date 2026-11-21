#!/usr/bin/env bash
# Renders every scene in main.rs SCENES headlessly at 1440 x 900 (1x) into screenshots/rune-v5/.
# Linux without a GPU: install mesa-vulkan-drivers; this uses its software Vulkan (lavapipe).
# BIN=target/debug/codeply OUT=dir SCENES="agents chat" tools/snap.sh to pick.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e /usr/share/vulkan/icd.d/lvp_icd.json ] && export VK_ICD_FILENAMES="${VK_ICD_FILENAMES:-/usr/share/vulkan/icd.d/lvp_icd.json}"
bin=${BIN:-target/release/codeply}
out=${OUT:-screenshots/rune-v5}
all=$(sed -n '/^const SCENES/,/^];/p' src/main.rs | sed -n 's/^    ("\([a-z-]*\)",.*/\1/p')
mkdir -p "$out"
for scene in ${SCENES:-$all}; do
  "$bin" --snap "$out/$scene.png" --scene "$scene" --size 1440x900 --scale 1 --at "${AT:-2.0}" >/dev/null
  echo "$out/$scene.png"
done
