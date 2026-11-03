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
if not os.path.exists("/kaggle/working/codeply"):
    subprocess.run(["git", "clone", "-b", "research/paste-architecture", "https://github.com/AwaisSDev/Codeply-Craft",
                    "/kaggle/working/codeply"], check=True)
subprocess.run(["git", "-C", "/kaggle/working/codeply", "checkout", COMMIT], check=True)
os.chdir("/kaggle/working/codeply/research/paste")
subprocess.run("pip -q install tokenizers==0.23.3 huggingface_hub==2.4.0", shell=True, check=True)
DATA = "__DATA__"
man = json.load(open(f"{DATA}/MANIFEST.json"))
for f, h in man["sha256"].items():
    assert hashlib.sha256(open(f"{DATA}/{f}", "rb").read()).hexdigest() == h, f"{f} changed"
    assert not any(x in f for x in ("test", "stress", "frozen")), "Kaggle must not receive test/stress data"
os.environ["PASTE_HF_CACHE"] = "/kaggle/working/hf"
TRAIN = f"{DATA}/train-mix-full.jsonl"
VAL = f"{DATA}/val-programmatic.jsonl {DATA}/val-api.jsonl"
print(subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv", shell=True, capture_output=True, text=True).stdout)'''

SMOKE = r'''# Throughput: 40 episodes per configuration, no curriculum, accum 2; segments/s from the trainer log
res = {}
for system in ("PASTE", "M1c"):
    for amp in ("", "--amp"):
        name = f"smoke-{system}{amp.replace('--', '-')}"
        out = f"/kaggle/working/runs/{name}"
        t = time.time()
        r = subprocess.run(f"python -m paste.train --system {system} --head-norm __PASTE_FLAGS__ --train {TRAIN}:0-40 --val {DATA}/val-programmatic.jsonl "
                           f"--val-limit 5 --epochs 1 --accum 2 --curriculum 0 --bio-weight 5 --ckpt-every 20 --device cuda {amp} --out {out}",
                           shell=True, capture_output=True, text=True)
        log = [json.loads(l) for l in open(f"{out}/log.jsonl")] if os.path.exists(f"{out}/log.jsonl") else []
        res[name] = {"rc": r.returncode, "wall_s": round(time.time() - t), "seg_per_s": [x.get("seg_per_s") for x in log],
                     "loss": [x.get("loss") for x in log], "err": r.stderr[-1500:] if r.returncode else ""}
        print(name, json.dumps(res[name]), flush=True)
json.dump(res, open("/kaggle/working/smoke.json", "w"), indent=1)'''

TRAIN_CELL = r'''# Runs of this group (resumable within the session; each run: train with per-epoch val + early stopping)
RUNS = __RUNS__
for r in RUNS:
    out = f"/kaggle/working/runs/{r['name']}"
    if os.path.exists(f"{out}/final.pt"):
        continue
    cmd = (f"python -m paste.train --system {r['system']} --seed {r['seed']} --train {TRAIN}{r.get('slice', '')} --val {VAL} "
           f"--device cuda {r['args']} --out {out}")
    print(cmd, flush=True)
    subprocess.run(cmd, shell=True, check=True)
subprocess.run("cd /kaggle/working && tar czf runs.tgz --exclude='*/last.pt' runs", shell=True, check=True)'''


def nb(title, intro, cells):
    def cell(src, kind="code"):
        c = {"cell_type": kind, "metadata": {}, "source": src.strip("\n").splitlines(keepends=True)}
        if kind == "code":
            c.update({"execution_count": None, "outputs": []})
        return c
    return {"cells": [cell(f"# {title}\n\n{intro}", "markdown")] + [cell(c) for c in cells],
            "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                         "language_info": {"name": "python"}, "kaggle": {"accelerator": "nvidiaTeslaT4", "isInternetEnabled": True}},
            "nbformat": 4, "nbformat_minor": 5}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", required=True)
    ap.add_argument("--runs", help="JSON: list of groups, each a list of {name, system, seed, args, slice?}")
    ap.add_argument("--paste-flags", default="", help="PASTE-only flags for the smoke run (e.g. --profile-rows)")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    setup = SETUP.replace("__COMMIT__", a.commit).replace("__DATA__", DATA)
    smoke = SMOKE.replace("__PASTE_FLAGS__", "{'" + a.paste_flags + "' if system == 'PASTE' else ''}") if a.paste_flags else SMOKE.replace("__PASTE_FLAGS__", "")
    json.dump(nb("PASTE: T4 throughput smoke test", "Measures segments/s for PASTE and M1c (fp32, AMP). Train data only.",
                 [setup, smoke]), open(os.path.join(a.out, "paste-smoke.ipynb"), "w"), indent=1)
    if a.runs:
        for k, group in enumerate(json.load(open(a.runs))):
            cell = TRAIN_CELL.replace("__RUNS__", json.dumps(group, indent=1))
            json.dump(nb(f"PASTE training group {k}", "Train + val only; test is evaluated off Kaggle.", [setup, cell]),
                      open(os.path.join(a.out, f"paste-train-{k}.ipynb"), "w"), indent=1)
    print("written to", a.out)


if __name__ == "__main__":
    main()
