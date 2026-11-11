"""Kaggle GPU job for Codeply Iris: train and validate two foundation sizes (Qwen3-0.6B, Qwen3-1.7B) on the same data.

Inputs: the private dataset `codeply-iris-src` (research/iris code + train and validation data; the test split is
not uploaded, so nothing here can read it). Base models come from Hugging Face (public, no token).
Outputs in /kaggle/working: iris-out-<size>.tgz (adapters, training logs, validation results, self-output data)
and pipeline-<size>.log. With two GPUs the two sizes run side by side, one per GPU; with one they run in turn.
"""
import glob
import os
import shutil
import subprocess
import sys
import time

t0 = time.time()
W = "/kaggle/working"
SIZES = (("Qwen/Qwen3-0.6B", "0.6b", "2e-4"), ("Qwen/Qwen3-1.7B", "1.7b", "1e-4"))


def sh(cmd, **kw):
    print("+", cmd, flush=True)
    return subprocess.run(cmd, shell=True, **kw)


def tail(path, n=3):
    try:
        with open(path, errors="replace") as f:
            return [l.rstrip()[:300] for l in f.readlines()[-n:]]
    except OSError:
        return []


sh("nvidia-smi --query-gpu=index,name,memory.total --format=csv || echo NO_GPU")
sh(f"{sys.executable} -m pip -q uninstall -y torchao 2>&1 | tail -1")     # an old torchao makes peft refuse to build LoRA layers
sh(f"{sys.executable} -m pip -q install -U 'transformers>=4.57' peft accelerate 2>&1 | tail -2")
sh(f"{sys.executable} -c \"import torch, peft, transformers; print('torch', torch.__version__, 'peft', peft.__version__, "
   f"'transformers', transformers.__version__, 'gpus', torch.cuda.device_count())\"")
import torch  # noqa: E402

n_gpu = torch.cuda.device_count()
if not n_gpu:
    raise SystemExit("NO GPU in this session: stopping before any training (check the GPU quota).")

hits = glob.glob("/kaggle/input/**/codeply_iris/__init__.py", recursive=True)
if not hits:                                                     # the dataset arrived as an archive: unpack it
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    hits = glob.glob(f"{W}/src/**/codeply_iris/__init__.py", recursive=True)
if not hits:
    sh("find /kaggle/input -maxdepth 4 | head -50")
    raise SystemExit("codeply_iris not found under /kaggle/input")
src = os.path.dirname(os.path.dirname(hits[0]))
print("code:", src, flush=True)


def launch(base, tag, lr, gpu):
    work = f"{W}/repo-{tag}"
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(src, work)
    env = dict(os.environ, PY=sys.executable, TOKENIZERS_PARALLELISM="false", CUDA_VISIBLE_DEVICES=str(gpu), PYTHONUNBUFFERED="1")
    sh(f"cd {work} && {sys.executable} -m codeply_iris.build --raw data/raw --out data/built | grep -E '^(train|val|leak)' | cut -c1-240")
    log = open(f"{W}/pipeline-{tag}.log", "w")
    return subprocess.Popen(f"bash scripts/gpu_pipeline.sh {base} {tag} {lr}", shell=True, cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)


def pack(tag):
    work = f"{W}/repo-{tag}"
    sh(f"cd {work} && tar czf {W}/iris-out-{tag}.tgz --exclude='*/ckpt' runs results/gpu data/built/train-selfplay-*.jsonl "
       f"data/built/MANIFEST.json 2>&1 | tail -2; ls -la {W}/iris-out-{tag}.tgz")


def watch(procs):
    """Print progress every 5 minutes until every pipeline has ended; package each one as it ends."""
    done = set()
    last = 0
    while len(done) < len(procs):
        time.sleep(20)
        for tag, p in procs.items():
            if tag not in done and p.poll() is not None:
                done.add(tag)
                print(f"== {tag} ended (exit {p.returncode}) at {(time.time() - t0) / 60:.0f} min", flush=True)
                for l in tail(f"{W}/pipeline-{tag}.log", 40):
                    print(f"   [{tag}] {l}", flush=True)
                pack(tag)
        if time.time() - last > 300:
            last = time.time()
            for tag in procs:
                if tag in done:
                    continue
                logs = sorted(glob.glob(f"{W}/repo-{tag}/runs/*/train-log.jsonl"), key=os.path.getmtime)
                where = (os.path.basename(os.path.dirname(logs[-1])) + " " + " ".join(tail(logs[-1], 1))) if logs else "starting"
                print(f"[{(time.time() - t0) / 60:.0f} min] {tag}: {where} | {' '.join(tail(f'{W}/pipeline-{tag}.log', 1))}", flush=True)


if n_gpu >= 2:
    watch({tag: launch(base, tag, lr, i) for i, (base, tag, lr) in enumerate(SIZES)})
else:
    for base, tag, lr in SIZES:
        watch({tag: launch(base, tag, lr, 0)})
for _, tag, _ in SIZES:
    shutil.rmtree(f"{W}/repo-{tag}", ignore_errors=True)      # keep only the archives and logs as kernel output
print("ALL_DONE", f"{(time.time() - t0) / 60:.0f} min", flush=True)
