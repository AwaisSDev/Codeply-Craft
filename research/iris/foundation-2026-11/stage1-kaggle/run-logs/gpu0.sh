set -e
cd /kaggle/working/iris
echo '=== qwen3-4b-2507 start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --constrain --out results/foundation-2026-11/qwen3-4b-2507
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --constrain --closed-loop --out results/foundation-2026-11/qwen3-4b-2507
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --limit 6 --out results/foundation-2026-11/qwen3-4b-2507-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-4b-2507
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-4b-2507 --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-4b-2507-unconstrained
echo '=== qwen3-4b-2507 done' $(date -u +%T)
echo '=== gemma-4-e2b start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/gemma-4-E2B_q4_0-it.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/gemma-4-e2b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/gemma-4-E2B_q4_0-it.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --closed-loop --out results/foundation-2026-11/gemma-4-e2b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/gemma-4-E2B_q4_0-it.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --limit 6 --out results/foundation-2026-11/gemma-4-e2b-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/gemma-4-e2b
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/gemma-4-e2b --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/gemma-4-e2b-unconstrained
echo '=== gemma-4-e2b done' $(date -u +%T)