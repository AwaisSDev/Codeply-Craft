"""Closed-loop validation sweep over write thresholds, keeping per-episode counts (validation only).

For each theta_W in the grid, every val episode is replayed in closed loop (thresholds change the trajectory) and its
per-episode counts are saved. `tools/val_compare.py` then selects theta_W by cross-fitting over plans (choose on one
half of the plans, score the other half) and compares runs with a paired bootstrap, so that the threshold is never
chosen on the episodes it is scored on.

    python tools/val_sweep.py --run RUN_DIR --val V1.jsonl V2.jsonl [--grid 0.5 0.8 0.9 0.95 0.98] [--limit 0]

Writes RUN_DIR/sweep/th<theta>.json = {"theta_W", "files": {basename: [per-episode records]}}; resumable per theta.
"""
import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from paste.adapter import PasteAdapter  # noqa: E402
from paste.config import PasteConfig  # noqa: E402
from paste.evaluate import evaluate, model_propose  # noqa: E402
from paste.modernbert import ettin_files  # noqa: E402
from paste.text import Text  # noqa: E402
from paste.train import load_eps, make_model  # noqa: E402

GRID = (0.5, 0.8, 0.9, 0.95, 0.98)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--val", nargs="+", required=True)
    ap.add_argument("--grid", type=float, nargs="+", default=list(GRID))
    ap.add_argument("--limit", type=int, default=0, help="first N episodes per val file (0 = all)")
    ap.add_argument("--ckpt", default="final.pt")
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    if any("frozen" in v or "/test-" in v or "/stress-" in v for v in a.val):
        raise SystemExit("validation data only")
    torch.set_num_threads(a.threads)
    conf = json.load(open(os.path.join(a.run, "config.json")))
    cfg = PasteConfig.from_run(conf)
    text = Text(ettin_files(cfg.backbone)[1])
    model = make_model(conf["system"], cfg, text)
    model.load_state_dict(torch.load(os.path.join(a.run, a.ckpt), weights_only=False, map_location="cpu")["model"])
    model.eval()
    files = {os.path.basename(v): (load_eps([v])[:a.limit] if a.limit else load_eps([v])) for v in a.val}
    out_dir = os.path.join(a.run, "sweep" if a.ckpt == "final.pt" else f"sweep-{os.path.splitext(a.ckpt)[0]}")
    os.makedirs(out_dir, exist_ok=True)
    for th in a.grid:
        path = os.path.join(out_dir, f"th{th:.2f}.json")
        if os.path.exists(path):
            continue
        thr = dict(cfg.thresholds, write=th, merge=max(th, cfg.thresholds["merge"]))
        res = {"theta_W": th, "files": {}}
        for name, eps in files.items():
            with torch.no_grad():
                s, per = evaluate(eps, model_propose(PasteAdapter(model, text, thresholds=thr)))
            res["files"][name] = per
            print(json.dumps({"theta_W": th, "file": name, "PE": s["PE"], "FPM": s["FPM_per_100_segments"]}), flush=True)
        tmp = path + ".tmp"
        json.dump(res, open(tmp, "w"))
        os.replace(tmp, path)


if __name__ == "__main__":
    main()
