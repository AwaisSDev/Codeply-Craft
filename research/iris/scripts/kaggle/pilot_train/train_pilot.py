"""P1: seed-1 training of the matched LoRA pilot (EVAL-PLAN A4) on Kaggle 2 x T4. No evaluation here.

Inputs: dataset codeply-iris-pilot-src (code, train + val; no test). Base models from Hugging Face (public).
T4 #0: Qwen3-4B-Instruct-2507. T4 #1: Qwen3-1.7B, then Gemma 4 E2B. Each with foundation-2026-11/pilot/configs/<m>.json,
unchanged except `out`. Outputs: /kaggle/working/runs/pilot-<m>-s1/{best,final}/adapter, train-log.jsonl, config.json,
DONE, and one log per model. Resumable: if an earlier version's output is attached, training continues from its ckpt.
"""
import glob, json, os, shutil, subprocess, sys, threading, time
T0 = time.time()
W = "/kaggle/working"
PINS = "transformers==5.23.0 peft==0.22.0 accelerate==1.16.0"
smi = subprocess.run("nvidia-smi --query-gpu=index,name --format=csv,noheader", shell=True, capture_output=True, text=True).stdout
print(smi, flush=True)
if smi.count("T4") < 2:
    raise SystemExit("two T4s required")
subprocess.run(f"{sys.executable} -m pip install -q {PINS}", shell=True)
init = sorted(glob.glob("/kaggle/input/**/codeply_iris/__init__.py", recursive=True))
if not init:
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    init = sorted(glob.glob(f"{W}/src/**/codeply_iris/__init__.py", recursive=True))
SRC = f"{W}/iris"
shutil.copytree(os.path.dirname(os.path.dirname(init[0])), SRC, dirs_exist_ok=True)
assert not os.path.exists(f"{SRC}/data/raw/test") and not os.path.exists(f"{SRC}/data/built/test.jsonl"), "test split present"
RUNS = f"{W}/runs"
os.makedirs(RUNS, exist_ok=True)
for prev in glob.glob("/kaggle/input/**/runs/pilot-*-s1", recursive=True):       # resume from an earlier version
    dst = f"{RUNS}/{os.path.basename(prev)}"
    if not os.path.exists(f"{dst}/DONE"):
        shutil.copytree(prev, dst, dirs_exist_ok=True)
        print("resume from", prev, flush=True)


def train(name, gpu):
    out = f"{RUNS}/pilot-{name}-s1"
    if os.path.exists(f"{out}/DONE"):
        return 0
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu), PYTHONUNBUFFERED="1", TOKENIZERS_PARALLELISM="false", HF_HOME="/tmp/hf",
               PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")   # less fragmentation; same computation
    resume = "--resume" if os.path.exists(f"{out}/ckpt/state.pt") else ""
    with open(f"{W}/train-{name}.log", "a") as log:
        return subprocess.run(f"{sys.executable} -m codeply_iris.train --config foundation-2026-11/pilot/configs/{name}.json "
                              f"--set out={out} {resume}", shell=True, cwd=SRC, env=env, stdout=log, stderr=subprocess.STDOUT).returncode


codes = {}
def worker(gpu, names):
    for n in names:
        t = time.time()
        codes[n] = {"exit": train(n, gpu), "minutes": round((time.time() - t) / 60, 1), "gpu": gpu}
        print(n, codes[n], flush=True)
ths = [threading.Thread(target=worker, args=(0, ["qwen3-4b-2507"])), threading.Thread(target=worker, args=(1, ["qwen3-1.7b", "gemma-4-e2b"]))]
for t in ths:
    t.start()
while any(t.is_alive() for t in ths):
    time.sleep(300)
    for n in ("qwen3-4b-2507", "qwen3-1.7b", "gemma-4-e2b"):
        p = f"{RUNS}/pilot-{n}-s1/train-log.jsonl"
        if os.path.exists(p):
            print(n, open(p).read().splitlines()[-1][:200], flush=True)
for n in ("qwen3-4b-2507", "qwen3-1.7b", "gemma-4-e2b"):
    if os.path.exists(f"{RUNS}/pilot-{n}-s1/DONE"):
        shutil.rmtree(f"{RUNS}/pilot-{n}-s1/ckpt", ignore_errors=True)   # optimiser state no longer needed
json.dump({"runs": codes, "elapsed_s": round(time.time() - T0), "source_commit": open(f"{SRC}/COMMIT.txt").read().strip()},
          open(f"{W}/train-status.json", "w"), indent=1)
