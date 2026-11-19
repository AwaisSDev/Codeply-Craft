"""Kaggle GPU parity / determinism check for wave A (EVAL-PLAN amendment A2). No evaluation of record.

Reuses the `codeply-iris-wave-a-check` output (CUDA llama.cpp at 7a4117e and the five GGUFs, sha256 re-verified) and the
code + validation dataset. Runs, for every model, exactly the command of the committed CPU references in
foundation-2026-11/stage1-kaggle/parity-cpu (first two val episodes, open loop, constrained, prompt v1.1), with
`--server-arg=-ngl --server-arg=99`, twice at the same time: pass A on GPU 0, pass B on GPU 1.
Outputs: /kaggle/working/parity-gpu-a|b/<model>/ and timing.json. CPU-vs-GPU comparison happens outside Kaggle
(compare_parity.py).
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import time

T0 = time.time()
W = "/kaggle/working"
MODELS = [("qwen3-0.6b", "Qwen3-0.6B-Q4_K_M.gguf", True), ("qwen3-1.7b", "Qwen3-1.7B-Q4_K_M.gguf", True),
          ("qwen3.5-2b", "Qwen3.5-2B-Q4_K_M.gguf", True), ("gemma-4-e2b", "gemma-4-E2B_q4_0-it.gguf", True),
          ("qwen3-4b-2507", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", False)]


def find(p):
    h = sorted(glob.glob(p, recursive=True))
    return h[0] if h else None


init = find("/kaggle/input/**/codeply_iris/__init__.py")
if not init:
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    init = find(f"{W}/src/**/codeply_iris/__init__.py")
SRC = f"{W}/iris"
shutil.copytree(os.path.dirname(os.path.dirname(init)), SRC, dirs_exist_ok=True)
assert not os.path.exists(f"{SRC}/data/raw/test") and not os.path.exists(f"{SRC}/data/built/test.jsonl")
# inputs are mounted read-only without the execute bit: copy the binaries + shared libraries and mark them executable
B = f"{W}/llama-bin"
shutil.copytree(os.path.dirname(find("/kaggle/input/**/llama-bin/llama-server")), B, dirs_exist_ok=True)
subprocess.run(f"chmod +x {B}/llama-server {B}/llama-bench", shell=True, check=True)
M = os.path.dirname(find("/kaggle/input/**/models/Qwen3-0.6B-Q4_K_M.gguf"))
smi = subprocess.run("nvidia-smi -L", shell=True, capture_output=True, text=True).stdout
print(smi, B, M, flush=True)
if "T4" not in smi:
    raise SystemExit("no T4 attached")
for l in open(f"{SRC}/foundation-2026-11/stage0/bench/GGUF-SHA256SUMS"):
    h, f = l.split()
    if subprocess.run(f"sha256sum {M}/{f}", shell=True, capture_output=True, text=True).stdout.split()[0] != h:
        raise SystemExit(f"sha256 mismatch {f}")
env = dict(os.environ, IRIS_LLAMA_SERVER=f"{B}/llama-server", LD_LIBRARY_PATH=B + ":" + os.environ.get("LD_LIBRARY_PATH", ""),
           PYTHONUNBUFFERED="1")


def cmds(tag):
    out = []
    for name, f, think in MODELS:
        kw = " --template-kwargs '{\"enable_thinking\": false}'" if think else ""
        out.append(f"echo '=== {name}' $(date +%s) && {sys.executable} -m codeply_iris.evaluate --system zeroshot --model {M}/{f} --chat{kw} "
                   f"--prompt-version v1.1 --constrain --threads 4 --limit 2 --split val --server-arg=-ngl --server-arg=99 "
                   f"--out {W}/parity-{tag}/{name}")
    return " && ".join(out) + " && echo '=== end' $(date +%s)"


procs = {tag: subprocess.Popen(cmds(tag), shell=True, cwd=SRC, env=dict(env, CUDA_VISIBLE_DEVICES=str(g)),
                               stdout=open(f"{W}/parity-{tag}.log", "w"), stderr=subprocess.STDOUT)
         for g, tag in ((0, "gpu-a"), (1, "gpu-b"))}
for p in procs.values():
    p.wait()
timing = {}
for tag in procs:
    marks = [l.split() for l in open(f"{W}/parity-{tag}.log") if l.startswith("=== ")]
    timing[tag] = {marks[i][1]: int(marks[i + 1][2]) - int(marks[i][2]) for i in range(len(marks) - 1)}
json.dump({"exit_codes": {t: p.returncode for t, p in procs.items()}, "seconds_per_model": timing,
           "elapsed_s": round(time.time() - T0), "source_commit": open(f"{SRC}/COMMIT.txt").read().strip()},
          open(f"{W}/timing.json", "w"), indent=1)
print(open(f"{W}/timing.json").read(), flush=True)
