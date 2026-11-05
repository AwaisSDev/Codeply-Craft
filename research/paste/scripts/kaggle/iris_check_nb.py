"""Kaggle CPU notebook: meaning check (iris.render.meaning_check) of the generator pilots' verified renders, with a
checker model that differs from the generators it judges. Each pilot's latest snapshot is restored from the private
HF backup inside the session (works on any Kaggle account); results are backed up to HF (prefix iris-check).

    python scripts/kaggle/iris_check_nb.py --commit SHA --llama-commit SHA --slug paste-iris-check \\
        --repo unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF --file Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf \\
        --pilots paste-iris-render-qwen4b paste-iris-render-phi4mini paste-iris-render-qwen30b --sample 40 --out DIR
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iris_render_nb import CELL as RENDER_CELL  # noqa: E402
from make_notebooks import SETUP, nb  # noqa: E402

HEAD = RENDER_CELL.split("subprocess.run(f\"python -m iris.sim.life")[0]          # build llama.cpp, download model, server up

TAIL = r'''lock = threading.Lock()
def snap(label):
    with lock:
        try:
            backup.snapshot(RUN, NAME, prefix="iris-check", label=label, meta={"commit": COMMIT})
        except Exception as e:
            print("backup failed", e, flush=True)
stop = threading.Event()
def periodic():
    while not stop.wait(1800):
        snap("periodic")
threading.Thread(target=periodic, daemon=True).start()
PILOTS = __PILOTS__
for k, pilot in enumerate(PILOTS):
    d = f"/tmp/pilots/{pilot}"
    if not os.path.exists(d):
        backup.restore(pilot, d, prefix="iris-render")
    left = DEADLINE - time.time()
    if left < 300:
        break
    p = subprocess.Popen(f"python -m iris.render.meaning_check --lives {d}/lives.jsonl --rendered {d}/rendered.jsonl "
                         f"--out {RUN}/meaning-{pilot}.jsonl --sample __SAMPLE__ --model checker", shell=True, start_new_session=True,
                         stdout=open(f"{RUN}/check.log", "a"), stderr=subprocess.STDOUT)
    try:
        p.wait(timeout=max(1, left / (len(PILOTS) - k)))          # equal share of the remaining time per pilot
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.wait(); break
    snap(f"done-{pilot}")
stop.set(); srv.terminate()
summ = {}
for f in sorted(glob.glob(f"{RUN}/meaning-*.jsonl")):
    rows = [json.loads(l) for l in open(f) if l.strip()]
    good = [r for r in rows if "ok" in r]
    summ[os.path.basename(f)] = {"checked": len(good), "meaning_ok": sum(r["ok"] for r in good),
                                 "extra_fact_renders": sum(bool(r["extra_facts"]) for r in good),
                                 "unfaithful_item_renders": sum(not all(r["faithful"]) for r in good if r["faithful"]),
                                 "errors": len(rows) - len(good)}
json.dump(summ, open(f"{RUN}/summary.json", "w"), indent=1); print(summ, flush=True)
snap("final")
subprocess.run("cd /kaggle/working && tar czf runs.tgz runs && rm -rf runs", shell=True)'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", required=True)
    ap.add_argument("--llama-commit", required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--pilots", nargs="+", required=True)
    ap.add_argument("--sample", type=int, default=40)
    ap.add_argument("--budget-s", type=int, default=36000)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    head = (HEAD.replace("__BUDGET__", str(a.budget_s)).replace("__SLUG__", a.slug).replace("__REPO__", a.repo)
            .replace("__FILE__", a.file).replace("__LLAMA__", a.llama_commit).replace("__CREPO__", "").replace("__CFILE__", ""))
    cell = "import glob\n" + head + TAIL.replace("__PILOTS__", json.dumps(a.pilots)).replace("__SAMPLE__", str(a.sample))
    os.makedirs(a.out, exist_ok=True)
    json.dump(nb(f"Iris meaning check: {a.slug}", "Free CPU session; checker model judges the generator pilots' renders.",
                 [SETUP.replace("__COMMIT__", a.commit), cell], gpu=False), open(os.path.join(a.out, f"{a.slug}.ipynb"), "w"), indent=1)
    print("written", os.path.join(a.out, f"{a.slug}.ipynb"))


if __name__ == "__main__":
    main()
