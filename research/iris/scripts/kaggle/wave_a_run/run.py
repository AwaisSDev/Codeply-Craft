"""Kaggle GPU run of wave A (EVAL-PLAN §3-§5, amendments A1-A2). Validation split only; nothing is trained.

Inputs:  dataset `codeply-iris-wave-a-src` (code + val only); kernel output of `codeply-iris-wave-a-check` (the CUDA
         llama.cpp build at the pinned commit and the five GGUFs, sha256-verified again here); optionally the output of
         an earlier version of this kernel (generation caches: every evaluate.py run resumes from preds-*.jsonl).
Work:    the same commands as foundation-2026-11/run_wave_a.sh, plus `--server-arg=-ngl --server-arg=99`, split over the
         two T4s (one process per GPU, systems in a fixed order).
Outputs: /kaggle/working/results/foundation-2026-11/<system>/ (preds, results, manifests, foundation reports) and one log
         per GPU; written as they are produced, so a session that ends early still leaves every finished system.
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
OFF = '{"enable_thinking": false}'
# (system, gguf, template kwargs, prompt version, mode); mode "full" = open + closed + unconstrained screen, "v1" = open only
GPU_QUEUES = {
    0: [("qwen3-4b-2507", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "", "v1.1", "full"),
        ("qwen3-1.7b", "Qwen3-1.7B-Q4_K_M.gguf", OFF, "v1.1", "full"),
        ("qwen3-0.6b-v1", "Qwen3-0.6B-Q4_K_M.gguf", OFF, "v1", "v1")],
    1: [("qwen3.5-2b", "Qwen3.5-2B-Q4_K_M.gguf", OFF, "v1.1", "full"),
        ("gemma-4-e2b", "gemma-4-E2B_q4_0-it.gguf", OFF, "v1.1", "full"),
        ("qwen3-0.6b", "Qwen3-0.6B-Q4_K_M.gguf", OFF, "v1.1", "full"),
        ("qwen3-1.7b-v1", "Qwen3-1.7B-Q4_K_M.gguf", OFF, "v1", "v1")],
}


def log(*a):
    print(f"[{time.time() - T0:7.0f}s]", *a, flush=True)


def find(pattern):
    hits = sorted(glob.glob(pattern, recursive=True))
    return hits[0] if hits else None


# code, binaries, models -------------------------------------------------------------------------------------------
init = find("/kaggle/input/**/codeply_iris/__init__.py")
if not init:
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    init = find(f"{W}/src/**/codeply_iris/__init__.py")
SRC = f"{W}/iris"
shutil.copytree(os.path.dirname(os.path.dirname(init)), SRC, dirs_exist_ok=True)
assert not os.path.exists(f"{SRC}/data/raw/test") and not os.path.exists(f"{SRC}/data/built/test.jsonl"), "test split present"
B = os.path.dirname(find("/kaggle/input/**/llama-bin/llama-server"))
M = os.path.dirname(find("/kaggle/input/**/models/Qwen3-0.6B-Q4_K_M.gguf"))
smi = subprocess.run("nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True)
log("gpus:", smi.stdout.strip().replace("\n", " | "), "bin:", B, "models:", M)
if smi.returncode or "T4" not in smi.stdout:
    raise SystemExit("no T4 attached: stopping before any work")
want = dict(reversed(l.split()) for l in open(f"{SRC}/foundation-2026-11/stage0/bench/GGUF-SHA256SUMS"))
for f, h in want.items():
    got = subprocess.run(f"sha256sum {M}/{f}", shell=True, capture_output=True, text=True).stdout.split()[0]
    if got != h:
        raise SystemExit(f"sha256 mismatch {f}")
log("GGUF sha256 verified")

# resume: copy caches from an earlier version of this kernel, if attached -------------------------------------------
RES = f"{SRC}/results/foundation-2026-11"
os.makedirs(RES, exist_ok=True)
for prev in glob.glob("/kaggle/input/**/results/foundation-2026-11/*/preds-val-*.jsonl", recursive=True):
    dst = os.path.join(RES, os.path.basename(os.path.dirname(prev)))
    os.makedirs(dst, exist_ok=True)
    shutil.copy(prev, dst)
    log("resume cache:", prev)


def script(queue):
    lines = ["set -e", f"cd {SRC}"]
    for name, gguf, kw, pv, mode in queue:
        out = f"results/foundation-2026-11/{name}"
        base = (f"{sys.executable} -m codeply_iris.evaluate --system zeroshot --model {M}/{gguf} --chat --prompt-version {pv} "
                f"--threads 4 --split val --server-arg=-ngl --server-arg=99" + (f" --template-kwargs '{kw}'" if kw else ""))
        lines.append(f"echo '=== {name} start' $(date -u +%T)")
        lines.append(f"{base} --constrain --out {out}")
        if mode == "full":
            lines.append(f"{base} --constrain --closed-loop --out {out}")
            lines.append(f"{base} --limit 6 --out {out}-unconstrained")
        lines.append(f"{sys.executable} foundation-2026-11/report_run.py {out}")
        if mode == "full":
            lines.append(f"{sys.executable} foundation-2026-11/report_run.py {out} --exclude-episode va01-e01")
            lines.append(f"{sys.executable} foundation-2026-11/report_run.py {out}-unconstrained")
        lines.append(f"echo '=== {name} done' $(date -u +%T)")
    return "\n".join(lines)


env = dict(os.environ, IRIS_LLAMA_SERVER=f"{B}/llama-server", LD_LIBRARY_PATH=B + ":" + os.environ.get("LD_LIBRARY_PATH", ""),
           PYTHONUNBUFFERED="1")
procs = {}
for gpu, queue in GPU_QUEUES.items():
    open(f"{W}/gpu{gpu}.sh", "w").write(script(queue))
    procs[gpu] = subprocess.Popen(["bash", f"{W}/gpu{gpu}.sh"], env=dict(env, CUDA_VISIBLE_DEVICES=str(gpu)),
                                  stdout=open(f"{W}/gpu{gpu}.log", "w"), stderr=subprocess.STDOUT)
while any(p.poll() is None for p in procs.values()):
    time.sleep(300)
    for gpu in procs:
        tail = open(f"{W}/gpu{gpu}.log", errors="replace").read().splitlines()[-1:]
        log(f"gpu{gpu}:", tail[0][:200] if tail else "")
codes = {g: p.returncode for g, p in procs.items()}
shutil.copytree(f"{SRC}/results", f"{W}/results", dirs_exist_ok=True)
json.dump({"exit_codes": codes, "elapsed_s": round(time.time() - T0), "source_commit": open(f"{SRC}/COMMIT.txt").read().strip()},
          open(f"{W}/run-status.json", "w"), indent=1)
log("done", codes)
