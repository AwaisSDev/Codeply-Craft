"""Kaggle CPU notebook: render simulator lives with a local GGUF model (llama.cpp server), verify, and back up every
30 minutes to the private HF repo (paste.backup, prefix iris-render). Free CPU sessions only; no GPU, no API.
Validation-phase data only (split 'pilot' lives, generated in the session from the pinned code).

    python scripts/kaggle/iris_render_nb.py --commit SHA --slug paste-iris-render-qwen30b \\
        --repo unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF --file Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf \\
        [--lives 3 --seed 100 --budget-s 23400] --out DIR
then: bash scripts/kaggle/push.sh DIR/<slug>.ipynb <slug> cpu
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_notebooks import SETUP, nb  # noqa: E402

LLAMA_COMMIT = "__LLAMA__"

CELL = r'''# Render pilot lives with a local model; verifier keeps the gold exact; HF backup every 30 min (paste.backup)
import threading, signal, urllib.request
sys_path = "/tmp/codeply/research/paste"; import sys; sys.path.insert(0, sys_path)
from paste import backup
DEADLINE = time.time() + __BUDGET__
NAME = "__SLUG__"
RUN = f"/kaggle/working/runs/{NAME}"; os.makedirs(RUN, exist_ok=True)
t0 = time.time()
if not os.path.exists("/tmp/llama/build/bin/llama-server"):
    subprocess.run("git clone -q https://github.com/ggml-org/llama.cpp /tmp/llama && cd /tmp/llama && git checkout -q __LLAMA__ && "
                   "cmake -B build -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF "
                   "-DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TOOLS=ON > /tmp/cmake.log 2>&1 && "
                   "cmake --build build -j 4 --target llama-server > /tmp/build.log 2>&1", shell=True, check=True)
print("build s", round(time.time() - t0), flush=True)
from huggingface_hub import hf_hub_download
model = hf_hub_download("__REPO__", "__FILE__", local_dir="/tmp/models")
print("model", model, round(os.path.getsize(model) / 1e9, 2), "GB; s", round(time.time() - t0), flush=True)
srv = subprocess.Popen(["/tmp/llama/build/bin/llama-server", "-m", model, "-t", "4", "-c", "8192", "--host", "127.0.0.1",
                        "--port", "8080"], stdout=open(f"{RUN}/server.log", "w"), stderr=subprocess.STDOUT,
                       env=dict(os.environ, LD_LIBRARY_PATH="/tmp/llama/build/bin"))
for _ in range(600):
    try:
        if b'"ok"' in urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=5).read():
            break
    except Exception:
        pass
    time.sleep(2)
print("server up; s", round(time.time() - t0), flush=True)
json.dump({"repo": "__REPO__", "file": "__FILE__", "llama_commit": "__LLAMA__", "code_commit": COMMIT, "cpus": os.cpu_count()},
          open(f"{RUN}/config.json", "w"), indent=1)
subprocess.run(f"python -m iris.sim.life --split pilot --n __LIVES__ --seed __SEED__ --out {RUN}/lives.jsonl", shell=True, check=True)
lock = threading.Lock()
def snap(label):
    with lock:
        try:
            backup.snapshot(RUN, NAME, prefix="iris-render", label=label, meta={"commit": COMMIT})
        except Exception as e:
            print("backup failed", e, flush=True)
stop = threading.Event()
def periodic():
    while not stop.wait(1800):
        snap("periodic")
threading.Thread(target=periodic, daemon=True).start()
p = subprocess.Popen(f"python -m iris.render.render --lives {RUN}/lives.jsonl --out {RUN}/rendered.jsonl --model __SLUG__ --tries 3",
                     shell=True, start_new_session=True, stdout=open(f"{RUN}/render.log", "a"), stderr=subprocess.STDOUT)
try:
    p.wait(timeout=max(1, DEADLINE - time.time()))
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL); p.wait()
    open(f"{RUN}/TIME_GUARD", "w").write("stopped by the time guard\n")
stop.set(); srv.terminate()
rows = [json.loads(l) for l in open(f"{RUN}/rendered.jsonl")] if os.path.exists(f"{RUN}/rendered.jsonl") else []
summ = {"events": len(rows), "ok": sum(r["ok"] for r in rows), "pass_rate": round(sum(r["ok"] for r in rows) / max(1, len(rows)), 3),
        "mean_s": round(sum(r["seconds"] for r in rows) / max(1, len(rows)), 1),
        "completion_tokens": sum(u.get("completion_tokens", 0) for r in rows for u in r.get("usage", []))}
json.dump(summ, open(f"{RUN}/summary.json", "w"), indent=1); print(summ, flush=True)
snap("final")
subprocess.run("cd /kaggle/working && tar czf runs.tgz runs && rm -rf runs", shell=True)'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--lives", type=int, default=3)
    ap.add_argument("--seed", type=int, default=100)
    ap.add_argument("--budget-s", type=int, default=23400)
    ap.add_argument("--llama-commit", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cell = (CELL.replace("__BUDGET__", str(a.budget_s)).replace("__SLUG__", a.slug).replace("__REPO__", a.repo)
            .replace("__FILE__", a.file).replace("__LIVES__", str(a.lives)).replace("__SEED__", str(a.seed))
            .replace("__LLAMA__", a.llama_commit))
    os.makedirs(a.out, exist_ok=True)
    json.dump(nb(f"Iris render pilot: {a.slug}", "Free CPU session; pilot lives rendered by a local model; validation only.",
                 [SETUP.replace("__COMMIT__", a.commit), cell], gpu=False), open(os.path.join(a.out, f"{a.slug}.ipynb"), "w"), indent=1)
    print("written", os.path.join(a.out, f"{a.slug}.ipynb"))


if __name__ == "__main__":
    main()
