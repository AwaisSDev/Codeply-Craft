#!/usr/bin/env bash
# Opens the app in a real window (Xvfb on a headless Linux box), lets it settle on a view, and
# prints its resident memory (VmRSS) every few seconds. Usage: tools/rss.sh [scene] [seconds]
set -euo pipefail
cd "$(dirname "$0")/.."
scene="${1:-office}" secs="${2:-30}"
[ -e /usr/share/vulkan/icd.d/lvp_icd.json ] && export VK_ICD_FILENAMES="${VK_ICD_FILENAMES:-/usr/share/vulkan/icd.d/lvp_icd.json}"
if [ -z "${DISPLAY:-}" ]; then Xvfb :77 -screen 0 1600x1000x24 >/dev/null 2>&1 & xpid=$!; export DISPLAY=:77; sleep 1; fi
target/release/codeply --scene "$scene" >/dev/null 2>&1 & pid=$!
for ((t = 5; t <= secs; t += 5)); do
  sleep 5
  echo "$scene t=${t}s $(grep -E 'VmRSS|VmHWM' /proc/$pid/status | tr -s ' ' | tr '\n' ' ')"
done
kill $pid 2>/dev/null || true; [ -n "${xpid:-}" ] && kill $xpid 2>/dev/null || true
