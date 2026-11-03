"""Write-threshold calibration on validation only (EVALUATION-PROTOCOL.md §5): replay the val episodes in closed
loop at each theta_W and keep the one minimising 3*FP + FN over persistent operations. Each threshold is a full
replay, because thresholds change the closed-loop trajectory.

    python -m paste.calibrate --run RUN_DIR --val V.jsonl [--limit 200]
"""
import argparse
import json
import os

import torch

from .adapter import PasteAdapter
from .config import PasteConfig
from .evaluate import OPS, evaluate, model_propose
from .modernbert import ettin_files
from .text import Text
from .train import load_eps, make_model

GRID = (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--val", nargs="+", required=True)
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--cost", type=float, default=3.0)
    a = ap.parse_args()
    if any("frozen" in v or "/test-" in v or "/stress-" in v for v in a.val):
        raise SystemExit("calibration uses validation data only")
    conf = json.load(open(os.path.join(a.run, "config.json")))
    cfg = PasteConfig(head_norm=conf.get("head_norm", False), flat_address=conf.get("flat_address", False))
    text = Text(ettin_files(cfg.backbone)[1])
    model = make_model(conf["system"], cfg, text)
    model.load_state_dict(torch.load(os.path.join(a.run, "final.pt"), weights_only=False)["model"])
    model.eval()
    eps = []
    for v in a.val:
        eps += load_eps([v])[:a.limit]
    rows = []
    for th in GRID:
        thr = dict(cfg.thresholds, write=th, merge=max(th, cfg.thresholds["merge"]))
        with torch.no_grad():
            s, per = evaluate(eps, model_propose(PasteAdapter(model, text, thresholds=thr)))
        fp = sum(s["per_op"][k]["fp"] for k in OPS); fn = sum(s["per_op"][k]["fn"] for k in OPS)
        rows.append({"theta_W": th, "cost": a.cost * fp + fn, "PE": s["PE"], "FPM": s["FPM_per_100_segments"],
                     "precision": s["precision"], "recall": s["recall"]})
        print(json.dumps(rows[-1]), flush=True)
    best = min(rows, key=lambda r: r["cost"])
    json.dump({"grid": rows, "chosen": best, "cost_ratio": a.cost, "val_files": a.val, "limit": a.limit},
              open(os.path.join(a.run, "calibration.json"), "w"), indent=1)
    print(json.dumps({"chosen": best}), flush=True)


if __name__ == "__main__":
    main()
