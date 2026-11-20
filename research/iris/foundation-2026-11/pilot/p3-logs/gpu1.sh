set -e
cd /kaggle/working/iris
echo '=== qwen3-1.7b start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/qwen3-1.7b-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/pilot-s1/qwen3-1.7b
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/qwen3-1.7b-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --closed-loop --out results/foundation-2026-11/pilot-s1/qwen3-1.7b
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/qwen3-1.7b-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --limit 6 --out results/foundation-2026-11/pilot-s1/qwen3-1.7b-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/qwen3-1.7b
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/qwen3-1.7b --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/qwen3-1.7b-unconstrained
echo '=== qwen3-1.7b done' $(date -u +%T)
echo '=== gemma-4-e2b start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/gemma-4-e2b-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/pilot-s1/gemma-4-e2b
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/gemma-4-e2b-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --closed-loop --out results/foundation-2026-11/pilot-s1/gemma-4-e2b
/usr/bin/python3 -m codeply_iris.evaluate --system iris --model /kaggle/input/notebooks/awaissididique/codeply-iris-pilot-export/gguf/gemma-4-e2b-pilot-s1-Q4_K_M.gguf --chat --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --limit 6 --out results/foundation-2026-11/pilot-s1/gemma-4-e2b-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/gemma-4-e2b
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/gemma-4-e2b --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/pilot-s1/gemma-4-e2b-unconstrained
echo '=== gemma-4-e2b done' $(date -u +%T)