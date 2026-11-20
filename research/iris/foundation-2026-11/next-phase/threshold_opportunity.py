#!/usr/bin/env python3
"""DESCRIPTIVE ONLY: how much a confidence threshold could change precision / recall / false memories for the pilot
models (seed 1), measured on VALIDATION labels. This shows the size of the opportunity; it must NOT be used to choose a
threshold (EVAL-PLAN A4; next-phase protocol: thresholds come from a calibration split carved out of training data).

Open loop is exact: dropping an op does not change later inputs. Closed loop is not replayable exactly (the store would
differ, so later prompts would differ); it is not reported here.
Score = mean token log-probability of the op's value (confidence.op_scores); unscored ops are dropped by any threshold.

    cd research/iris && python3 foundation-2026-11/next-phase/threshold_opportunity.py
"""
import json, math, sys
from collections import Counter
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(ROOT / "audit-r4"))
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402
SYSTEMS = ["qwen3-4b-2507", "gemma-4-e2b", "qwen3-1.7b"]
TAUS = [None, -0.01, -0.02, -0.05, -0.1, -0.2, -0.3, -0.5]


def sweep(name):
    recs = R.records(ROOT / "results/foundation-2026-11/pilot-s1" / name, "val", "open")
    rows = []
    for tau in TAUS:
        tot = Counter()
        for r in recs:
            hit = r["hit"]
            content = [o for o in r["pred"] if o["op"] in contract.PERSISTENT_OPS]
            sc = confidence.op_scores(hit.get("answer", ""), hit.get("logprobs"), content) if hit.get("logprobs") else [None] * len(content)
            drop = {id(o) for o, s in zip(content, sc) if tau is not None and (s is None or s < tau)}
            kept = [o for o in r["pred"] if id(o) not in drop]
            c, _ = metrics.score_observe(kept, r["gold"], r["memories"], r["rejected"])
            tot.update(c)
        s = metrics.summarise(tot)
        rows.append({"tau_mean_logprob": tau, "tau_prob": None if tau is None else round(math.exp(tau), 3), "content_ops": int(tot["pred_content"]),
                     "precision": round(s["extraction_precision"], 3), "recall": round(s["extraction_recall"], 3), "f1": round(s["extraction_f1"], 3),
                     "false_per_100": round(100 * tot["false_memory"] / tot["sessions"], 1)})
    return rows


out = {"note": "validation labels: descriptive opportunity only, never a threshold choice", "loop": "open", "systems": {n: sweep(n) for n in SYSTEMS}}
(HERE / "threshold_opportunity.json").write_text(json.dumps(out, indent=1) + "\n")
for n, rows in out["systems"].items():
    print(n)
    for r in rows:
        print(f"   tau {str(r['tau_mean_logprob']):6s} (p {str(r['tau_prob']):5s}) ops {r['content_ops']:3d} P {r['precision']} R {r['recall']} F1 {r['f1']} false/100 {r['false_per_100']}")
