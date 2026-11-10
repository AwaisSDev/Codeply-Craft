"""Kaggle GPU job for Codeply Iris: clone the public codeply-iris branch, train and validate two foundation
sizes on the same data, and leave adapters + validation results in /kaggle/working/iris-out.tgz.
No credentials are needed or used: the repository is public and the outputs are fetched with `kaggle kernels output`."""
import os
import subprocess
import sys
import time

def sh(cmd, **kw):
    print("+", cmd, flush=True)
    return subprocess.run(cmd, shell=True, **kw)

t0 = time.time()
sh("nvidia-smi --query-gpu=name,memory.total --format=csv")
sh("pip install -q -U 'transformers>=4.57' peft accelerate 2>&1 | tail -2")
sh("rm -rf /kaggle/working/repo && git clone -q --depth 1 --branch codeply-iris https://github.com/AwaisSDev/Codeply-Craft /kaggle/working/repo")
os.chdir("/kaggle/working/repo/research/iris")
sh("git log --oneline -1")
sh(f"{sys.executable} -m codeply_iris.build --raw data/raw --out data/built | grep -E '^(train|val|leak)' | cut -c1-240")
env = dict(os.environ, PY=sys.executable, TOKENIZERS_PARALLELISM="false")
for base, tag, lr in (("Qwen/Qwen3-0.6B", "0.6b", "2e-4"), ("Qwen/Qwen3-1.7B", "1.7b", "1e-4")):
    sh(f"bash scripts/gpu_pipeline.sh {base} {tag} {lr}", env=env)
    print(f"== {tag} done at {(time.time() - t0) / 60:.0f} min", flush=True)
    # package after each size so a time-out still leaves the finished one
    sh("tar czf /kaggle/working/iris-out.tgz --exclude='*/ckpt' runs results/gpu data/built/train-selfplay-*.jsonl data/built/MANIFEST.json")
sh("rm -rf /kaggle/working/repo")          # keep only the archive as kernel output
print("ALL_DONE", f"{(time.time() - t0) / 60:.0f} min", flush=True)
