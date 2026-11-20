#!/usr/bin/env python3
"""Compare two candidate threshold rules for the exploratory threshold hypothesis (no selection; E2 on hold).

  Rule R (recall-capped):   tau = the strictest grid threshold whose recall loss on the calibration set is <= 0.02
  Rule V (volume-capped):   tau = the strictest grid threshold that keeps >= 85 % of the model's content ops on the
                            calibration set
Confidence = mean value-token log-probability (A4); unscored ops are dropped once any threshold applies.

DESCRIPTIVE PROXY ONLY. A real calibration set does not exist yet, so calibration-sized draws (24 episodes, with
replacement) from the seed-1 DEVELOPMENT outputs (validation, open loop) stand in for it, and the consequences are
read on the same development episodes. That makes every number optimistic and none of it evidence for a claim.
Nothing is selected here; the owner chooses a rule (or neither) before E2, without these numbers deciding it.

    cd research/iris && python3 foundation-2026-11/next-phase/threshold_rules_compare.py
"""
import json, random, sys
from collections import Counter, defaultdict
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(ROOT / "audit-r4"))
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402

GRID = [-1.0, -0.75, -0.5, -0.4, -0.3, -0.2, -0.15, -0.1, -0.05, -0.02, -0.01]     # loosest -> strictest
MODELS = {"qwen3-4b (seed 1)": "results/foundation-2026-11/pilot-s1/qwen3-4b-2507",
          "gemma-4-e2b (seed 1)": "results/foundation-2026-11/pilot-s1/gemma-4-e2b",
          "qwen3-1.7b control (seed 1)": "results/foundation-2026-11/pilot-s1/qwen3-1.7b"}
DRAWS, CAL_EPISODES, RECALL_CAP, KEEP = 1000, 24, 0.02, 0.85


def per_episode(run):
    per = defaultdict(lambda: {str(t): Counter() for t in [None] + GRID})
    for r in R.records(ROOT / run, "val", "open"):
        hit = r["hit"]
        content = [o for o in r["pred"] if o["op"] in contract.PERSISTENT_OPS]
        sc = confidence.op_scores(hit.get("answer", ""), hit.get("logprobs"), content) if hit.get("logprobs") else [None] * len(content)
        for t in [None] + GRID:
            drop = {id(o) for o, s in zip(content, sc) if t is not None and (s is None or s < t)}
            c, _ = metrics.score_observe([o for o in r["pred"] if id(o) not in drop], r["gold"], r["memories"], r["rejected"])
            per[r["episode"]][str(t)].update(c)
    return per


def agg(per, draw, t):
    c = Counter()
    for e in draw:
        c.update(per[e][str(t)])
    s = metrics.summarise(c)
    return {"recall": s["extraction_recall"], "precision": s["extraction_precision"], "ops": c["pred_content"],
            "false_per_100": 100 * c["false_memory"] / c["sessions"]}


def choose(per, draw, rule):
    base = agg(per, draw, None)
    best = None
    for t in GRID:                                         # loosest -> strictest; keep the strictest that qualifies
        a = agg(per, draw, t)
        okk = (base["recall"] - a["recall"] <= RECALL_CAP) if rule == "R" else (a["ops"] >= KEEP * base["ops"])
        if okk:
            best = t
    return best


out = {"status": "descriptive proxy on development data; not a selection; optimistic (calibration and read-out share episodes)",
       "rules": {"R": f"strictest tau with calibration recall loss <= {RECALL_CAP}", "V": f"strictest tau keeping >= {int(KEEP * 100)} % of content ops"},
       "models": {}}
for name, run in MODELS.items():
    per = per_episode(run)
    ids = sorted(per)
    full0 = agg(per, ids, None)
    rng = random.Random(0)
    res = {}
    for rule in ("R", "V"):
        picks, dfp, drc, dpr, keep = Counter(), [], [], [], []
        for _ in range(DRAWS):
            d = [rng.choice(ids) for _ in range(CAL_EPISODES)]
            t = choose(per, d, rule)
            picks[str(t)] += 1
            f = agg(per, ids, t)
            dfp.append(f["false_per_100"] - full0["false_per_100"])
            drc.append(f["recall"] - full0["recall"])
            dpr.append(f["precision"] - full0["precision"])
            keep.append(f["ops"] / full0["ops"])
        q = lambda v: [round(sorted(v)[int(p * (len(v) - 1))], 3) for p in (0.05, 0.5, 0.95)]   # noqa: E731
        res[rule] = {"tau_chosen": {k: round(v / DRAWS, 3) for k, v in picks.most_common()},
                     "delta_false_per_100_p5_p50_p95": q(dfp), "delta_recall_p5_p50_p95": q(drc),
                     "delta_precision_p5_p50_p95": q(dpr), "ops_kept_share_p5_p50_p95": q(keep),
                     "share_of_draws_recall_loss_over_0.03": round(sum(1 for x in drc if x < -0.03) / DRAWS, 3)}
    out["models"][name] = {"no_threshold": {k: round(v, 3) for k, v in full0.items()}, **res}
(HERE / "threshold_rules_compare.json").write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps(out, indent=1))
