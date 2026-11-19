set -e
cd /kaggle/working/iris
echo '=== qwen3.5-2b start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3.5-2B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/qwen3.5-2b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3.5-2B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --closed-loop --out results/foundation-2026-11/qwen3.5-2b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3.5-2B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --limit 6 --out results/foundation-2026-11/qwen3.5-2b-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3.5-2b
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3.5-2b --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3.5-2b-unconstrained
echo '=== qwen3.5-2b done' $(date -u +%T)
echo '=== qwen3-1.7b start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-1.7B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/qwen3-1.7b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-1.7B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --closed-loop --out results/foundation-2026-11/qwen3-1.7b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-1.7B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --limit 6 --out results/foundation-2026-11/qwen3-1.7b-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-1.7b
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-1.7b --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-1.7b-unconstrained
echo '=== qwen3-1.7b done' $(date -u +%T)
echo '=== qwen3-0.6b start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-0.6B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/qwen3-0.6b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-0.6B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --closed-loop --out results/foundation-2026-11/qwen3-0.6b
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-0.6B-Q4_K_M.gguf --chat --prompt-version v1.1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --limit 6 --out results/foundation-2026-11/qwen3-0.6b-unconstrained
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-0.6b
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-0.6b --exclude-episode va01-e01
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-0.6b-unconstrained
echo '=== qwen3-0.6b done' $(date -u +%T)
echo '=== qwen3-1.7b-v1 start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-1.7B-Q4_K_M.gguf --chat --prompt-version v1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/qwen3-1.7b-v1
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-1.7b-v1
echo '=== qwen3-1.7b-v1 done' $(date -u +%T)
echo '=== qwen3-0.6b-v1 start' $(date -u +%T)
/usr/bin/python3 -m codeply_iris.evaluate --system zeroshot --model /kaggle/input/notebooks/awaissididique/codeply-iris-wave-a-check/models/Qwen3-0.6B-Q4_K_M.gguf --chat --prompt-version v1 --threads 4 --split val --server-arg=-ngl --server-arg=99 --template-kwargs '{"enable_thinking": false}' --constrain --out results/foundation-2026-11/qwen3-0.6b-v1
/usr/bin/python3 foundation-2026-11/report_run.py results/foundation-2026-11/qwen3-0.6b-v1
echo '=== qwen3-0.6b-v1 done' $(date -u +%T)