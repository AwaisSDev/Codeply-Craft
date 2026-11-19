"""Kaggle validation session for the Iris foundation study, wave A (EVAL-PLAN amendment A2). No full evaluation.

Inputs: private dataset `codeply-iris-wave-a-src` (research/iris code, validation split only, GGUF sha256 list).
The test and train splits are not in the dataset, so nothing here can read them.

Steps, each logged to /kaggle/working/check/:
  1. hardware: GPUs, VRAM, driver, CUDA, CPUs, RAM, disk          (stops immediately when no GPU is attached)
  2. llama.cpp at the pinned commit, CUDA build for sm_75 (T4): llama-server, llama-bench   -> /kaggle/working/llama-bin
  3. the five wave-A GGUFs from Hugging Face, sha256 verified (fail closed)                -> /kaggle/working/models
  4. llama-bench on GPU (-ngl 99, pp512 / pp2048 / tg128); VRAM after load and after one request, and the layer-offload
     lines of the server log, per model
  5. parity sessions: evaluate.py --limit 2 (first two val episodes, open loop, constrained, prompt v1.1), every
     model, two passes at once (pass A on GPU 0, pass B on GPU 1): GPU determinism; CPU reference comparison is
     done afterwards outside Kaggle against the committed CPU outputs
Outputs stay in /kaggle/working (kept as the kernel output; the models and binaries are reused by the full run).
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

T0 = time.time()
W = "/kaggle/working"
OUT = f"{W}/check"
os.makedirs(OUT, exist_ok=True)
LLAMA_COMMIT = "7a4117eef97ed6419241da2384b2b1c011ecd763"
MODELS = [  # name, hf repo, file, thinking switch
    ("qwen3-0.6b", "unsloth/Qwen3-0.6B-GGUF", "Qwen3-0.6B-Q4_K_M.gguf", True),
    ("qwen3-1.7b", "unsloth/Qwen3-1.7B-GGUF", "Qwen3-1.7B-Q4_K_M.gguf", True),
    ("qwen3.5-2b", "unsloth/Qwen3.5-2B-GGUF", "Qwen3.5-2B-Q4_K_M.gguf", True),
    ("gemma-4-e2b", "google/gemma-4-E2B-it-qat-q4_0-gguf", "gemma-4-E2B_q4_0-it.gguf", True),
    ("qwen3-4b-2507", "unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", False),
]
STATUS = {"steps": {}}


def log(*a):
    print(f"[{time.time() - T0:7.0f}s]", *a, flush=True)


def sh(cmd, check=False, **kw):
    log("+", cmd[:300])
    r = subprocess.run(cmd, shell=True, text=True, capture_output=True, **kw)
    if r.returncode and check:
        print(r.stdout[-3000:], r.stderr[-3000:], flush=True)
        raise SystemExit(f"failed: {cmd[:200]}")
    return r


def save():
    STATUS["elapsed_s"] = round(time.time() - T0)
    with open(f"{OUT}/status.json", "w") as f:
        json.dump(STATUS, f, indent=1)


def step(name):
    STATUS["steps"][name] = {"start_s": round(time.time() - T0)}
    save()


def done(name, **info):
    STATUS["steps"][name].update(end_s=round(time.time() - T0), **info)
    save()


# 1. hardware -----------------------------------------------------------------------------------------------------
step("hardware")
smi = sh("nvidia-smi --query-gpu=index,name,memory.total,driver_version,compute_cap --format=csv,noheader")
gpus = [l.strip() for l in smi.stdout.splitlines() if l.strip()]
hw = {"gpus": gpus, "nvidia_smi_rc": smi.returncode,
      "cuda_runtime": sh("nvidia-smi | grep -o 'CUDA Version: [0-9.]*'").stdout.strip(),
      "nvcc": sh("nvcc --version | tail -2").stdout.strip(), "nproc": os.cpu_count(),
      "mem": sh("free -g | sed -n 2p").stdout.strip(), "disk_working": sh(f"df -h {W} | tail -1").stdout.strip(),
      "python": sys.version.split()[0], "cmake": sh("cmake --version | head -1").stdout.strip()}
json.dump(hw, open(f"{OUT}/hardware.json", "w"), indent=1)
done("hardware", **hw)
log(json.dumps(hw))
if not gpus:
    raise SystemExit("NO GPU attached: stopping before any work (check the GPU quota / accelerator setting).")

# source dataset ----------------------------------------------------------------------------------------------------
hits = glob.glob("/kaggle/input/**/codeply_iris/__init__.py", recursive=True)
if not hits:                                                     # the dataset arrived as an archive: unpack it
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    hits = glob.glob(f"{W}/src/**/codeply_iris/__init__.py", recursive=True)
if not hits:
    sh("find /kaggle/input -maxdepth 5 | head -60")
    raise SystemExit("codeply_iris not found under /kaggle/input")
SRC = f"{W}/iris"
shutil.rmtree(SRC, ignore_errors=True)
shutil.copytree(os.path.dirname(os.path.dirname(hits[0])), SRC)
assert not os.path.exists(f"{SRC}/data/raw/test") and not os.path.exists(f"{SRC}/data/built/test.jsonl"), "test split present"
STATUS["source_commit"] = open(f"{SRC}/COMMIT.txt").read().strip() if os.path.exists(f"{SRC}/COMMIT.txt") else "unknown"
save()

# 2. llama.cpp CUDA build ------------------------------------------------------------------------------------------
step("build")
B = f"{W}/llama-bin"
if not os.path.exists(f"{B}/llama-server"):
    sh(f"rm -rf /tmp/llama && mkdir /tmp/llama && cd /tmp/llama && git init -q && git remote add origin https://github.com/ggml-org/llama.cpp.git "
       f"&& git fetch -q --depth 1 origin {LLAMA_COMMIT} && git checkout -q FETCH_HEAD", check=True)
    sh("cd /tmp/llama && cmake -S . -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=75 -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF "
       "-DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release > /tmp/llama/cmake.log 2>&1", check=True)
    r = sh(f"cd /tmp/llama && cmake --build build -j{os.cpu_count()} --target llama-server llama-bench > /tmp/llama/build.log 2>&1")
    shutil.copy("/tmp/llama/build.log", f"{OUT}/llama-build.log")
    if r.returncode:
        raise SystemExit("llama.cpp build failed (see check/llama-build.log)")
    os.makedirs(B, exist_ok=True)
    sh(f"cp -a /tmp/llama/build/bin/. {B}/", check=True)
ver = sh(f"{B}/llama-server --version 2>&1 | tail -3").stdout.strip()
done("build", version=ver)
log(ver)
os.environ["IRIS_LLAMA_SERVER"] = f"{B}/llama-server"
os.environ["LD_LIBRARY_PATH"] = B + ":" + os.environ.get("LD_LIBRARY_PATH", "")

# 3. models ----------------------------------------------------------------------------------------------------------
step("models")
M = f"{W}/models"
os.makedirs(M, exist_ok=True)
want = {}
for l in open(f"{SRC}/foundation-2026-11/stage0/bench/GGUF-SHA256SUMS"):
    h, f = l.split()
    want[f.lstrip("*")] = h
sums = {}
for name, repo, f, _ in MODELS:
    p = f"{M}/{f}"
    if not os.path.exists(p):
        sh(f"curl -sS -L --retry 4 -o {p}.part https://huggingface.co/{repo}/resolve/main/{f} && mv {p}.part {p}", check=True)
    sums[f] = sh(f"sha256sum {p}").stdout.split()[0]
    if sums[f] != want[f]:
        raise SystemExit(f"sha256 mismatch for {f}: {sums[f]} != {want[f]}")
done("models", sha256=sums)

# 4. benchmarks and VRAM ---------------------------------------------------------------------------------------------
step("bench")
bench = {}
for name, repo, f, _ in MODELS:
    r = sh(f"{B}/llama-bench -m {M}/{f} -ngl 99 -t 4 -p 512,2048 -n 128 -r 2 -o json", env=dict(os.environ, CUDA_VISIBLE_DEVICES="0"))
    try:
        rows = json.loads(r.stdout)
        bench[name] = {("pp%d" % x["n_prompt"]) if x["n_gen"] == 0 else ("tg%d" % x["n_gen"]): round(x["avg_ts"], 1) for x in rows}
    except ValueError:
        bench[name] = {"error": (r.stderr or r.stdout)[-800:]}
    log(name, bench[name])
json.dump(bench, open(f"{OUT}/bench-gpu.json", "w"), indent=1)
done("bench", **bench)

step("vram")
sys.path.insert(0, SRC)
from codeply_iris import contract, prompt  # noqa: E402
from codeply_iris.infer import ChatServerBackend  # noqa: E402

val = [json.loads(l) for l in open(f"{SRC}/data/built/val.jsonl") if l.strip()]
ex = next(e for e in val if e["task"] == "observe")
user = prompt.observe_prompt(ex["now"], ex["source"], [{k: v for k, v in m.items() if k != "key"} for m in ex["memories"]], ex["messages"])


def gpu_mem(i=0):
    r = sh(f"nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i {i}")
    return int(r.stdout.strip() or 0)


vram = {}
for name, repo, f, think in MODELS:
    base = gpu_mem(0)
    logf = open(f"{OUT}/server-{name}.log", "w")
    port = 18700
    proc = subprocess.Popen([f"{B}/llama-server", "-m", f"{M}/{f}", "--port", str(port), "-c", "8192", "--parallel", "1", "--no-webui",
                             "-t", "4", "--jinja", "--reasoning-format", "auto", "-ngl", "99"], stdout=logf, stderr=subprocess.STDOUT,
                            env=dict(os.environ, CUDA_VISIBLE_DEVICES="0"))
    ok = False
    for _ in range(600):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                ok = r.status == 200
                break
        except Exception:
            time.sleep(0.5)
    loaded = gpu_mem(0)
    t = time.time()
    try:
        b = ChatServerBackend(url=f"http://127.0.0.1:{port}", constrain=True, template_kwargs={"enable_thinking": False} if think else None)
        raw, st = b.generate_chat(prompt.ZERO_SHOT_SYSTEM_V11, user, 900, contract.OUTPUT_SCHEMA)
        gen = {"seconds": round(time.time() - t, 2), "new_tokens": st["new_tokens"], "prompt_tokens": st["prompt_tokens"]}
    except Exception as e:
        gen = {"error": repr(e)[:300]}
    after = gpu_mem(0)
    proc.terminate()
    proc.wait(timeout=60)
    logf.close()
    text = open(f"{OUT}/server-{name}.log", errors="replace").read()
    keep = [l.strip()[:200] for l in text.splitlines() if any(k in l for k in ("offloaded", "model buffer size", "KV buffer size",
                                                                              "compute buffer size", "CUDA0", "RS buffer", "ERROR", "error"))]
    vram[name] = {"healthy": ok, "gpu_mib_before": base, "gpu_mib_loaded": loaded, "gpu_mib_after_request": after,
                  "model_used_mib": after - base, "one_session": gen, "server_log": keep[:30]}
    log(name, {k: v for k, v in vram[name].items() if k != "server_log"})
json.dump(vram, open(f"{OUT}/vram.json", "w"), indent=1)
done("vram", **{k: v["model_used_mib"] for k, v in vram.items()})

# 5. parity / determinism -------------------------------------------------------------------------------------------
step("parity")


def pass_cmds(gpu, tag):
    cmds = []
    for name, repo, f, think in MODELS:
        kw = "--template-kwargs '{\"enable_thinking\": false}'" if think else ""
        cmds.append(f"{sys.executable} -m codeply_iris.evaluate --system zeroshot --model {M}/{f} --chat {kw} --prompt-version v1.1 "
                    f"--constrain --threads 4 --limit 2 --split val --server-arg=-ngl --server-arg=99 --out {OUT}/parity-{tag}/{name}")
    return " && ".join(cmds)


procs = {}
for gpu, tag in ((0, "gpu-a"), (1, "gpu-b")) if len(gpus) > 1 else ((0, "gpu-a"),):
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu), PYTHONUNBUFFERED="1")
    procs[tag] = subprocess.Popen(pass_cmds(gpu, tag), shell=True, cwd=SRC, env=env,
                                  stdout=open(f"{OUT}/parity-{tag}.log", "w"), stderr=subprocess.STDOUT)
for tag, p in procs.items():
    p.wait()
    log(tag, "exit", p.returncode)
if len(procs) == 1:   # one GPU only: run the determinism pass afterwards on the same GPU
    env = dict(os.environ, CUDA_VISIBLE_DEVICES="0", PYTHONUNBUFFERED="1")
    subprocess.run(pass_cmds(0, "gpu-b"), shell=True, cwd=SRC, env=env, stdout=open(f"{OUT}/parity-gpu-b.log", "w"), stderr=subprocess.STDOUT)


def preds(tag, name):
    p = f"{OUT}/parity-{tag}/{name}/preds-val-open.jsonl"
    return {json.loads(l)["id"]: json.loads(l) for l in open(p)} if os.path.exists(p) else {}


det = {}
for name, *_ in MODELS:
    a, b = preds("gpu-a", name), preds("gpu-b", name)
    same = sum(1 for k in a if k in b and a[k].get("answer", a[k]["raw"]) == b[k].get("answer", b[k]["raw"]))
    ms = sorted(v.get("ms", 0) for v in a.values())
    det[name] = {"examples": len(a), "identical_between_gpus": same, "p50_s": round(ms[len(ms) // 2] / 1000, 2) if ms else None,
                 "mean_s": round(sum(ms) / len(ms) / 1000, 2) if ms else None}
    log(name, det[name])
json.dump(det, open(f"{OUT}/determinism.json", "w"), indent=1)
done("parity", **det)
log("done")
