#!/usr/bin/env bash
# Renders every view headlessly at 1440 x 900 (1x) into screenshots/rune/.
# Linux without a GPU: install mesa-vulkan-drivers; this uses its software Vulkan (lavapipe).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -e /usr/share/vulkan/icd.d/lvp_icd.json ] && export VK_ICD_FILENAMES="${VK_ICD_FILENAMES:-/usr/share/vulkan/icd.d/lvp_icd.json}"
bin=target/release/codeply
mkdir -p screenshots/rune
for scene in ${SCENES:-board appearance office office-drawer chat chat-thread code prs apps settings}; do
  "$bin" --snap "screenshots/rune/$scene.png" --scene "$scene" --size 1440x900 --scale 1 --at "${AT:-2.0}" >/dev/null
  echo "screenshots/rune/$scene.png"
done
