"""Kaggle notebooks for PASTE (BASELINE-PLAN §2.6). Training only: Kaggle never receives test or stress data.

  python scripts/kaggle/make_notebooks.py --commit SHA [--runs runs.json]

paste-smoke.ipynb   T4 throughput check (spec §6.5 precision): PASTE and M1c, 40 train episodes each, fp32 vs AMP;
                    prints segments/s and the loss trace (~15 min of quota).
paste-train-<k>.ipynb  one notebook per run group (each fits one 12 h session); runs are resumable within a session.

Inputs (private Kaggle dataset `paste-trainval`, created from the private HF dataset; train and val only):
  train-mix-full.jsonl, val-programmatic.jsonl, val-api.jsonl, MANIFEST.json (sha256 of each file).
Code: the public branch research/paste-architecture at a pinned commit. Outputs: /kaggle/working/runs/<name>/
(final.pt, epoch*.pt, logs, val files), downloaded with `kaggle kernels output` (private kernel) and evaluated on
test here, on CPU, by `paste.evaluate --final` (EVALUATION-PROTOCOL §2).
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = "/kaggle/input/paste-trainval"

SETUP = r'''# Setup: pinned code (public branch), dependencies, data hashes
import os, subprocess, hashlib, json, time
COMMIT = "__COMMIT__"
if not os.path.exists("/tmp/codeply"):
    subprocess.run(["git", "clone", "-b", "research/paste-architecture", "https://github.com/AwaisSDev/Codeply-Craft",
                    "/tmp/codeply"], check=True)
subprocess.run(["git", "-C", "/tmp/codeply", "checkout", COMMIT], check=True)
os.chdir("/tmp/codeply/research/paste")
subprocess.run("pip -q install tokenizers==0.23.3 huggingface_hub==2.4.0", shell=True, check=True)
import glob
_m = sorted(glob.glob("/kaggle/input/**/MANIFEST.json", recursive=True))
print("manifests found:", _m)
assert _m, "paste-trainval dataset not mounted"
DATA = os.path.dirname(next((m for m in _m if "paste-trainval" in m), _m[0]))
man = json.load(open(f"{DATA}/MANIFEST.json"))
for f, h in man["sha256"].items():
    assert hashlib.sha256(open(f"{DATA}/{f}", "rb").read()).hexdigest() == h, f"{f} changed"
    assert not any(x in f for x in ("test", "stress", "frozen")), "Kaggle must not receive test/stress data"
os.environ["PASTE_HF_CACHE"] = "/tmp/hf"
TRAIN = f"{DATA}/train-mix-full.jsonl"
VAL = f"{DATA}/val-programmatic.jsonl {DATA}/val-api.jsonl"
print(subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv", shell=True, capture_output=True, text=True).stdout)'''

SMOKE = r'''# Throughput and the AMP rule (DECISIONS 2026-11-03/-04): 100 episodes per configuration, no curriculum, accum 2,
# a log entry every 10 episodes (10 entries: the AMP rule compares the mean loss of the last 10). Same seed and data
# order for fp32 and AMP. Closed-loop evaluation speed: one theta, first 20 episodes of each val file, fp32 checkpoint.
res = {}
def n_segments(path, k):
    with open(path) as f:
        return sum(len(json.loads(l)["segments"]) for _, l in zip(range(k), f))
VAL_SEGS = sum(n_segments(v, 20) for v in VAL.split())
for system in ("PASTE", "M1c", "M1c-m", "M1c+W"):
    for amp in ("", "--amp"):
        name = f"smoke-{system.replace('+', 'p')}{amp.replace('--', '-')}"
        out = f"/kaggle/working/runs/{name}"
        t = time.time()
        r = subprocess.run(f"python -m paste.train --system {system} --head-norm __PASTE_FLAGS__ --train {TRAIN}:0-100 --val {DATA}/val-programmatic.jsonl "
                           f"--val-limit 5 --epochs 1 --accum 2 --curriculum 0 --bio-weight 5 --ckpt-every 10 --device cuda {amp} __SMOKE_ARGS__ --out {out}",
                           shell=True, capture_output=True, text=True)
        log = [json.loads(l) for l in open(f"{out}/log.jsonl")] if os.path.exists(f"{out}/log.jsonl") else []
        res[name] = {"rc": r.returncode, "wall_s": round(time.time() - t), "seg_per_s": [x.get("seg_per_s") for x in log],
                     "loss": [x.get("loss") for x in log], "err": r.stderr[-1500:] if r.returncode else ""}
        if not amp and r.returncode == 0:
            t = time.time()
            e = subprocess.run(f"python tools/val_sweep.py --run {out} --val {VAL} --grid 0.98 --limit 20 --device cuda",
                               shell=True, capture_output=True, text=True)
            res[name]["eval_seg_per_s"] = round(VAL_SEGS / (time.time() - t), 2) if e.returncode == 0 else None
            res[name]["eval_err"] = e.stderr[-800:] if e.returncode else ""
        print(name, json.dumps(res[name]), flush=True)
json.dump(res, open("/kaggle/working/smoke.json", "w"), indent=1)
subprocess.run("cd /kaggle/working && rm -rf runs", shell=True)'''


TRAIN_CELL = r'''# Runs of this group: train (per-epoch val, early stopping) then paste.calibrate_full, validation only.
# Time guard: Kaggle stops a session at 12 h; work stops at __BUDGET_S__ s after this cell starts. An unfinished run keeps
# last.pt and its epoch checkpoints; a later session resumes it when this kernel's output is attached
# (push.sh with KERNEL_SOURCES=<owner/slug>): runs.tgz found under /kaggle/input is unpacked first.
import glob, signal
DEADLINE = time.time() + __BUDGET_S__
def run_until_deadline(cmd):
    """Run cmd in its own process group; on the deadline kill exactly that group (no pattern-based pkill, which
    could match this notebook's own name)."""
    p = subprocess.Popen(cmd, shell=True, start_new_session=True)
    try:
        rc = p.wait(timeout=max(1, DEADLINE - time.time()))
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.wait()
        raise
    if rc:
        raise subprocess.CalledProcessError(rc, cmd)
for p in sorted(glob.glob("/kaggle/input/**/runs.tgz", recursive=True)):
    print("resuming from", p, flush=True)
    subprocess.run(f"tar xzf {p} -C /kaggle/working", shell=True, check=True)
RUNS = __RUNS__
for r in RUNS:
    out = f"/kaggle/working/runs/{r['name']}"
    try:
        if not os.path.exists(f"{out}/final.pt"):
            train = " ".join(f"{TRAIN}:{s}" for s in r["slices"]) if r.get("slices") else f"{TRAIN}{r.get('slice', '')}"
            cmd = (f"python -m paste.train --system {r['system']} --seed {r['seed']} --train {train} --val {VAL} "
                   f"--device __DEVICE__ {r['args']} --out {out}")
            print(cmd, flush=True)
            run_until_deadline(cmd)
        if r.get("calibrate", True) and not os.path.exists(f"{out}/calibration-full.json"):
            cal = (f"python -m paste.calibrate_full --run {out} --val {VAL} --device __DEVICE__ --limit {r.get('cal_limit', 0)} "
                   f"--tf-limit {r.get('cal_tf_limit', 200)}")
            print(cal, flush=True)
            run_until_deadline(cal)
    except subprocess.TimeoutExpired:
        open(f"{out}/TIME_GUARD", "w").write("stopped by the session time guard; resume in a new session\n")
        print("TIME GUARD:", r["name"], flush=True)
        break
# finished runs (calibrated) are packed without resume checkpoints; unfinished ones keep last.pt and epoch*.pt
subprocess.run("cd /kaggle/working && for d in runs/*/; do rm -f $d/*.tmp; [ -f $d/calibration-full.json ] && rm -f $d/last.pt $d/epoch*.pt; done; "
               "tar czf runs.tgz runs && rm -rf runs && ls -la runs.tgz", shell=True, check=True)'''


CPU_QUEUE = r'''# Validation experiments on a free Kaggle CPU session (no GPU quota): scripts/queue.sh lines, train + full-val sweep
QUEUE = """__QUEUE__"""
os.makedirs("/kaggle/working/runs", exist_ok=True)
open("/kaggle/working/runs/queue.txt", "w").write(QUEUE)
env = dict(os.environ, PY="python", DATA=DATA, VAL_API=f"{DATA}/val-api.jsonl", RUNS="/kaggle/working/runs",
           PASTE_HF_CACHE="/tmp/hf", GRID="__GRID__")
# Time guard: Kaggle stops a session at 12 h and an unfinished run would leave no output. The queue is stopped at
# 11 h 15 min; finished runs (DONE) are packed without checkpoints, an unfinished run keeps last.pt so it can be resumed.
import signal
p = subprocess.Popen("bash scripts/queue.sh", shell=True, env=env, start_new_session=True)
try:
    p.wait(timeout=__BUDGET_S__)
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL); p.wait()                # exactly the queue's process group
    print("TIME GUARD: queue stopped")
    open("/kaggle/working/runs/TIME_GUARD", "w").write("stopped by the 11 h 15 min guard\n")
subprocess.run("cd /kaggle/working && for d in runs/*/; do [ -f $d/DONE ] && rm -f $d/last.pt; done; "
               "tar czf runs.tgz --exclude='*/epoch*.pt' runs && rm -rf runs && ls -la runs.tgz", shell=True)'''


def nb(title, intro, cells, gpu=True):
    def cell(src, kind="code"):
        c = {"cell_type": kind, "metadata": {}, "source": src.strip("\n").splitlines(keepends=True)}
        if kind == "code":
            c.update({"execution_count": None, "outputs": []})
        return c
    return {"cells": [cell(f"# {title}\n\n{intro}", "markdown")] + [cell(c) for c in cells],
            "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                         "language_info": {"name": "python"},
                         "kaggle": {"accelerator": "nvidiaTeslaT4" if gpu else "none", "isInternetEnabled": True}},
            "nbformat": 4, "nbformat_minor": 5}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", required=True)
    ap.add_argument("--runs", help="JSON: list of groups, each a list of {name, system, seed, args, slices?} (tools/make_groups.py)")
    ap.add_argument("--paste-flags", default="", help="PASTE-only flags for the smoke run (e.g. --profile-rows)")
    ap.add_argument("--smoke-args", default="", help="recipe flags for every smoke run (e.g. '--closed-loop 0.5 --lr-enc 1e-4'), so throughput matches the central recipe")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--cpu-queue", help="queue file (scripts/queue.sh format) for a CPU-only validation notebook")
    ap.add_argument("--slug", help="notebook name for --cpu-queue")
    ap.add_argument("--grid", default="0.8 0.9 0.95 0.98")
    ap.add_argument("--budget-s", type=int, default=40500, help="time guard (s) for CPU queues and training groups; Kaggle stops sessions at 12 h")
    ap.add_argument("--device", default="cuda", choices=("cuda", "cpu"), help="training groups: T4 (cuda) or a free CPU session")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    setup = SETUP.replace("__COMMIT__", a.commit)
    smoke = SMOKE.replace("__PASTE_FLAGS__", "{'" + a.paste_flags + "' if system == 'PASTE' else ''}") if a.paste_flags else SMOKE.replace("__PASTE_FLAGS__", "")
    smoke = smoke.replace("__SMOKE_ARGS__", a.smoke_args)
    json.dump(nb("PASTE: T4 throughput smoke test", "Measures segments/s for PASTE and M1c (fp32, AMP). Train data only.",
                 [setup, smoke]), open(os.path.join(a.out, "paste-smoke.ipynb"), "w"), indent=1)
    if a.runs:
        for k, group in enumerate(json.load(open(a.runs))):
            cell = (TRAIN_CELL.replace("__RUNS__", json.dumps(group, indent=1)).replace("__DEVICE__", a.device)
                    .replace("__BUDGET_S__", str(a.budget_s)))
            json.dump(nb(f"PASTE training group {k}", "Train + val only; test is evaluated off Kaggle.", [setup, cell],
                         gpu=a.device == "cuda"),
                      open(os.path.join(a.out, f"paste-train-{k}.ipynb"), "w"), indent=1)
    if a.cpu_queue:
        cell = (CPU_QUEUE.replace("__QUEUE__", open(a.cpu_queue).read()).replace("__GRID__", a.grid)
                .replace("__BUDGET_S__", str(a.budget_s)))
        json.dump(nb(f"PASTE validation experiments: {a.slug}", "Free CPU session; train + validation only.", [setup, cell], gpu=False),
                  open(os.path.join(a.out, f"{a.slug}.ipynb"), "w"), indent=1)
    print("written to", a.out)


if __name__ == "__main__":
    main()
