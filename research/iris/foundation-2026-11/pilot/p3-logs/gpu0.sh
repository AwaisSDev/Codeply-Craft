set -e
cd /kaggle/working/iris
echo '=== qwen3-4b-2507 start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/qwen3-4b-2507-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --constrain --out results/foundation-2026-11/pilot-s1/qwen3-4b-2507
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/qwen3-4b-2507-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --constrain --closed-loop --out results/foundation-2026-11/pilot-s1/qwen3-4b-2507
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/qwen3-4b-2507-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --limit 6 --out results/foundation-2026-11/pilot-s1/qwen3-4b-2507-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/qwen3-4b-2507
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/qwen3-4b-2507 --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/qwen3-4b-2507-unconstrained
echo '=== qwen3-4b-2507 done' $(date -u +%T)