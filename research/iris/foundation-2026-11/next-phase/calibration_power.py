#!/usr/bin/env python3
"""Statistical checks for the proposed E2 design (read-only; no model). Writes calibration_power.json.

1. Size of an 80/20 fit/calibration split of the teacher training episodes (sessions, gold content ops).
2. Threshold stability PROXY: with the seed-1 Qwen3-4B validation outputs (open loop), draw calibration-sized samples of
   episodes (with replacement), pick tau = argmax F0.5 on each, and look at the spread of tau and of the false-memory
   rate it implies. Validation labels are used here ONLY to estimate how noisy a calibration-sized choice is; nothing is
   selected from this.
3. Power: from the seed-1 paired bootstrap, the standard error of Δ false memories / 100 sessions between systems
   (24 episodes), the minimum detectable effect, and its expected size with 52 episodes; and the within-model paired
   effect of a threshold (same outputs, with and without it).

    cd research/iris && python3 foundation-2026-11/next-phase/calibration_power.py
"""
import json, math, random, sys
from collections import Counter, defaultdict
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(ROOT / "audit-r4"))
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402

GRID = [None, -0.01, -0.02, -0.05, -0.1, -0.15, -0.2, -0.3, -0.4, -0.5, -0.75, -1.0]
out = {}

# 1. split size
tr = [json.loads(l) for l in (ROOT / "data/built/train.jsonl").read_text().splitlines() if l.strip()]
teach = [e for e in tr if e["task"] == "observe" and e["shard"] != "syn01" and e.get("variant") == "gold"]
eps = sorted({e["episode"] for e in teach})
gold_ops = sum(sum(1 for o in json.loads(e["target"])["ops"] if o["op"] in ("add", "update", "conflict")) for e in teach)
out["split"] = {"teacher_episodes": len(eps), "teacher_gold_sessions": len(teach), "gold_content_ops": gold_ops,
                "calibration_20pct": {"episodes": round(0.2 * len(eps)), "sessions_approx": round(0.2 * len(teach)),
                                      "gold_content_ops_approx": round(0.2 * gold_ops)}}

# per-episode counts for the 4B open loop at each threshold
recs = R.records(ROOT / "results/foundation-2026-11/pilot-s1/qwen3-4b-2507", "val", "open")
per = defaultdict(lambda: {t: Counter() for t in map(str, GRID)})
for r in recs:
    hit = r["hit"]
    content = [o for o in r["pred"] if o["op"] in contract.PERSISTENT_OPS]
    sc = confidence.op_scores(hit.get("answer", ""), hit.get("logprobs"), content) if hit.get("logprobs") else [None] * len(content)
    for t in GRID:
        drop = {id(o) for o, s in zip(content, sc) if t is not None and (s is None or s < t)}
        c, _ = metrics.score_observe([o for o in r["pred"] if id(o) not in drop], r["gold"], r["memories"], r["rejected"])
        per[r["episode"]][str(t)].update(c)
ids = sorted(per)


def agg(draw, t):
    c = Counter()
    for e in draw:
        c.update(per[e][str(t)])
    return c


def f05(c):
    return confidence.f_beta(c["tp"], c["pred_content"], c["gold_content"])


# 2. threshold stability proxy: calibration-sized draws (17 episodes ~ 20 % of 84 teacher episodes; val has 24)
rng = random.Random(0)
k = out["split"]["calibration_20pct"]["episodes"]
picks = Counter()
false_at_pick = []
for _ in range(2000):
    d = [rng.choice(ids) for _ in range(k)]
    best = max(GRID, key=lambda t: (f05(agg(d, t)), -(t if t is not None else 0.0)))   # ties -> higher tau
    picks[str(best)] += 1
    full = agg(ids, best)
    false_at_pick.append(100 * full["false_memory"] / full["sessions"])
false_at_pick.sort()
out["threshold_stability_proxy"] = {
    "note": "validation outputs of seed-1 Qwen3-4B used only to estimate variability of a calibration-sized choice; no selection",
    "calibration_episodes_per_draw": k, "draws": 2000,
    "tau_chosen_distribution": {t: round(n / 2000, 3) for t, n in sorted(picks.items(), key=lambda x: -x[1])},
    "false_per_100_on_all_24_at_chosen_tau": {"p5": round(false_at_pick[100], 1), "median": round(false_at_pick[1000], 1), "p95": round(false_at_pick[1899], 1)}}

# 3. power
cmp = json.loads((HERE.parent / "pilot/PILOT-S1-COMPARISON.json").read_text())["comparisons"]
se = {c: (v["ci95"]["false_per_100"][1] - v["ci95"]["false_per_100"][0]) / 3.92 for c, v in cmp.items()}
mde = {c: round(2.8 * s, 1) for c, s in se.items()}
out["power_between_systems"] = {"se_delta_false_per_100_24_episodes": {c: round(s, 1) for c, s in se.items()},
                                "mde_80pct_power_24_episodes": mde,
                                "mde_80pct_power_52_episodes_expected": {c: round(m * math.sqrt(24 / 52), 1) for c, m in mde.items()}}
# within-model paired effect of a fixed threshold (example tau = -0.3) on the same outputs
draws = []
rng = random.Random(1)
for _ in range(2000):
    d = [rng.choice(ids) for _ in ids]
    a, b = agg(d, -0.3), agg(d, None)
    draws.append((100 * a["false_memory"] / a["sessions"] - 100 * b["false_memory"] / b["sessions"],
                  metrics.summarise(a)["extraction_recall"] - metrics.summarise(b)["extraction_recall"]))
fm = sorted(x for x, _ in draws); rc = sorted(y for _, y in draws)
out["within_model_threshold_effect_example"] = {
    "note": "descriptive, tau=-0.3 fixed for illustration (not a selection); open loop; 4B seed 1",
    "delta_false_per_100_ci95": [round(fm[50], 1), round(fm[1949], 1)], "delta_recall_ci95": [round(rc[50], 3), round(rc[1949], 3)]}
(HERE / "calibration_power.json").write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps(out, indent=1))
