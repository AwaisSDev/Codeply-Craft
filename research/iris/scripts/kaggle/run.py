"""Kaggle GPU job for Codeply Iris. Needs: a GPU and internet are NOT required; the code and the base model are
attached as private datasets (awaissdev/codeply-iris-src, awaissdev/qwen3-0-6b-base). Writes
/kaggle/working/iris-out.tgz with adapters, logs and validation results (no test-split results are produced)."""
import glob
import os
import shutil
import subprocess
import sys
import tarfile
import time

t0 = time.time()
def sh(cmd, **kw):
    print("+", cmd, flush=True)
    return subprocess.run(cmd, shell=True, **kw)

sh("nvidia-smi --query-gpu=name,memory.total --format=csv || echo NO_GPU")
src = next(os.path.dirname(p) for p in glob.glob("/kaggle/input/**/codeply_iris/__init__.py", recursive=True))
base = next(os.path.dirname(p) for p in glob.glob("/kaggle/input/**/model.safetensors", recursive=True))
print("code:", src, "base:", base, flush=True)
work = "/kaggle/working/repo/research/iris"
shutil.rmtree("/kaggle/working/repo", ignore_errors=True)
shutil.copytree(os.path.dirname(src) if os.path.basename(src) == "iris" else src, work)
os.chdir(work)
env = dict(os.environ, PY=sys.executable, TOKENIZERS_PARALLELISM="false", HF_HUB_OFFLINE="1")
sh(f"{sys.executable} -m codeply_iris.build --raw data/raw --out data/built | grep -E '^(train|val|leak)' | cut -c1-240")
sh(f"bash scripts/gpu_pipeline.sh {base} 0.6b 2e-4", env=env)
sh("tar czf /kaggle/working/iris-out.tgz --exclude='*/ckpt' runs results/gpu data/built/train-selfplay-*.jsonl data/built/MANIFEST.json")
print("ALL_DONE", f"{(time.time() - t0) / 60:.0f} min", flush=True)
