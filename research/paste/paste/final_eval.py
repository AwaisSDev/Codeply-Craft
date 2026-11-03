"""Final (test / stress) evaluation under the access rules of EVALUATION-PROTOCOL §2.

A run may read frozen data only when:
  * its entry (checkpoint SHA-256, model config, thresholds) is in results/final/FROZEN-RUNS.json, and that file is
    committed with no uncommitted changes;
  * the checkpoint's SHA-256 equals the frozen one;
  * every data file's SHA-256 equals results/FROZEN.json;
  * the (run, file) pair was not evaluated before; a rerun needs --rerun-reason and is logged as a deviation.
Each access appends a line to results/final/ACCESS-LOG.md. Per-episode counts (ids and integers only, no text) go
to results/final/<run>/<file>.json for paste.final_report.

    python -m paste.final_eval --run-name PASTE-s1 --ckpt CKPT.pt --data-dir FROZEN_DIR \
        --files test-programmatic.jsonl test-api.jsonl
Freezing a run: python -m paste.final_eval --freeze --run-name PASTE-s1 --run-dir RUN_DIR [--ckpt-name final.pt]
"""
import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys

import torch

from .adapter import PasteAdapter
from .config import PasteConfig
from .evaluate import evaluate, model_propose
from .modernbert import ettin_files
from .text import Text
from .train import load_eps, make_model

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Dry run of the whole procedure (tools/dryrun_central.sh): a scratch git repository with its own results/FROZEN.json
# listing validation stand-ins. In that mode, files named like test or stress data are refused outright.
DRY_ROOT = os.environ.get("PASTE_FINAL_DRYRUN_ROOT")
ROOT = DRY_ROOT or ROOT
FINAL = os.path.join(ROOT, "results", "final")
FROZEN_RUNS = os.path.join(FINAL, "FROZEN-RUNS.json")
ACCESS = os.path.join(FINAL, "ACCESS-LOG.md")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def freeze(a):
    """Append a run entry: checkpoint hash, model config and the thresholds of calibration-full.json."""
    conf = json.load(open(os.path.join(a.run_dir, "config.json")))
    cal = json.load(open(os.path.join(a.run_dir, a.calibration)))
    ck = os.path.join(a.run_dir, a.ckpt_name)
    entry = {"name": a.run_name, "system": conf["system"], "seed": conf["seed"], "checkpoint_sha256": sha256(ck),
             "model_config": {"head_norm": conf.get("head_norm", False), "flat_address": conf.get("flat_address", False),
                              "profile_rows": conf.get("profile_rows", False)},
             "thresholds": {k: cal["chosen"][k] for k in ("write", "forget", "merge", "retrieve", "expire")},
             "calibration_sha256": sha256(os.path.join(a.run_dir, a.calibration)),
             "train_config": conf, "frozen_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    os.makedirs(FINAL, exist_ok=True)
    fr = json.load(open(FROZEN_RUNS)) if os.path.exists(FROZEN_RUNS) else {"runs": []}
    if any(r["name"] == a.run_name for r in fr["runs"]):
        sys.exit(f"{a.run_name} is already frozen")
    fr["runs"].append(entry)
    json.dump(fr, open(FROZEN_RUNS, "w"), indent=1)
    print(json.dumps({k: entry[k] for k in ("name", "system", "seed", "checkpoint_sha256", "thresholds")}))
    print("now commit results/final/FROZEN-RUNS.json before any final evaluation")


def committed_clean(path):
    rel = os.path.relpath(path, ROOT)
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", rel], cwd=ROOT, capture_output=True).returncode == 0
    clean = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", rel], cwd=ROOT).returncode == 0
    return tracked and clean


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-name", required=True)
    ap.add_argument("--freeze", action="store_true")
    ap.add_argument("--run-dir")
    ap.add_argument("--ckpt-name", default="final.pt")
    ap.add_argument("--calibration", default="calibration-full.json")
    ap.add_argument("--ckpt")
    ap.add_argument("--data-dir")
    ap.add_argument("--files", nargs="+", default=[])
    ap.add_argument("--rerun-reason", default="")
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    if a.freeze:
        return freeze(a)
    if not committed_clean(FROZEN_RUNS):
        sys.exit("FROZEN-RUNS.json must be committed and unmodified before any final evaluation (protocol §2)")
    run = next((r for r in json.load(open(FROZEN_RUNS))["runs"] if r["name"] == a.run_name), None)
    if run is None:
        sys.exit(f"{a.run_name} is not in FROZEN-RUNS.json")
    if sha256(a.ckpt) != run["checkpoint_sha256"]:
        sys.exit("checkpoint hash differs from the frozen one")
    frozen = json.load(open(os.path.join(ROOT, "results", "FROZEN.json")))["files"]
    log = open(ACCESS).read() if os.path.exists(ACCESS) else ""
    for f in a.files:
        if DRY_ROOT and (any(x in f for x in ("test", "stress")) or "frozen" in os.path.abspath(a.data_dir)):
            sys.exit("dry run: validation stand-ins only")
        if f not in frozen:
            sys.exit(f"{f} is not a frozen file")
        if sha256(os.path.join(a.data_dir, f)) != frozen[f]["sha256"]:
            sys.exit(f"{f}: data hash differs from results/FROZEN.json")
        if f"| {a.run_name} | {f} |" in log and not a.rerun_reason:
            sys.exit(f"{a.run_name} was already evaluated on {f}; a rerun needs --rerun-reason (logged as a deviation)")
    torch.set_num_threads(a.threads)
    cfg = PasteConfig(**run["model_config"])
    text = Text(ettin_files(cfg.backbone)[1])
    model = make_model(run["system"], cfg, text)
    model.load_state_dict(torch.load(a.ckpt, weights_only=False, map_location="cpu")["model"])
    model.eval()
    thr = dict(cfg.thresholds, **run["thresholds"])
    out_dir = os.path.join(FINAL, a.run_name)
    os.makedirs(out_dir, exist_ok=True)
    if not os.path.exists(ACCESS):
        open(ACCESS, "w").write("# Final evaluation access log (protocol §2)\n\n| UTC | run | file | seed | checkpoint sha256 | data sha256 | note |\n|---|---|---|---|---|---|---|\n")
    for f in a.files:
        eps = load_eps([os.path.join(a.data_dir, f)])
        with torch.no_grad():
            summary, per = evaluate(eps, model_propose(PasteAdapter(model, text, thresholds=thr)))
        json.dump({"summary": summary, "per_episode": per}, open(os.path.join(out_dir, f.replace(".jsonl", ".json")), "w"))
        note = f"DEVIATION rerun: {a.rerun_reason}" if a.rerun_reason else ""
        with open(ACCESS, "a") as fh:
            fh.write(f"| {datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')} | {a.run_name} | {f} | "
                     f"{run['seed']} | {run['checkpoint_sha256'][:16]} | {frozen[f]['sha256'][:16]} | {note} |\n")
        print(json.dumps({"run": a.run_name, "file": f, "PE": summary["PE"], "FPM": summary["FPM_per_100_segments"]}), flush=True)


if __name__ == "__main__":
    main()
