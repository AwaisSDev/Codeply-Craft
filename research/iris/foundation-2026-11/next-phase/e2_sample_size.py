#!/usr/bin/env python3
"""Sample size for the E2 evaluation design (read-only; seed-1 outputs; no model, no test). Writes e2_sample_size.json.

Between-system difference in false memories / 100 sessions, k seeds per system, n evaluation episodes:
    Var(Δ) ≈ SD_ep² / n  +  2 σ_seed² / k
SD_ep: per-episode SD of the paired difference, from the seed-1 closed-loop comparisons (one seed, so it also holds
the episode x seed interaction; treated as not shrinking with k: conservative). σ_seed: SD of a system's false / 100
across training seeds at fixed episodes. **Unknown** (one seed exists), so it is a scenario grid. MDE = (1.96 + 0.84) x
sqrt(Var) (two-sided 5 %, power 80 %). Recall is done the same way.

Within-model contrasts (same outputs, e.g. a threshold vs none) have no seed or between-model term; their per-episode
SD comes from the paired bootstrap in calibration_power.py.

Calibration-set size: threshold stability PROXY, as in calibration_power.py (4B seed-1 validation outputs; draws with
replacement of m episodes; tau = argmax F0.5 on the grid). Validation labels are used only for variability; nothing is
selected. Draws above 24 episodes reuse the same 24 episodes, so they understate the spread there.

    cd research/iris && python3 foundation-2026-11/next-phase/e2_sample_size.py
"""
import json, math, random, sys
from collections import Counter, defaultdict
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(ROOT / "audit-r4"))
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402

Z = 1.96 + 0.84
out = {}
cmp = json.loads((HERE.parent / "pilot/PILOT-S1-COMPARISON.json").read_text())["comparisons"]
sd = {}
for c, v in cmp.items():
    se_f = (v["ci95"]["false_per_100"][1] - v["ci95"]["false_per_100"][0]) / 3.92
    se_r = (v["ci95"]["recall"][1] - v["ci95"]["recall"][0]) / 3.92
    sd[c] = {"false_per_100": se_f * math.sqrt(24), "recall": se_r * math.sqrt(24)}
out["per_episode_sd_of_paired_difference_seed1_closed"] = {c: {k: round(x, 3) for k, x in v.items()} for c, v in sd.items()}
SDF = max(v["false_per_100"] for v in sd.values())
SDR = max(v["recall"] for v in sd.values())


def mde(sd_ep, n, sigma_s, k):
    return Z * math.sqrt(sd_ep ** 2 / n + 2 * sigma_s ** 2 / k)


grid = {}
for sigma in (0, 5, 10, 15):
    for k in (1, 3, 5):
        grid[f"sigma_seed={sigma},k={k}"] = {str(n): round(mde(SDF, n, sigma, k), 1) for n in (24, 52, 76, 100, 150, 200)}
out["mde_false_per_100_between_systems"] = {"sd_ep_used": round(SDF, 1), "by_scenario_and_episodes": grid}


def n_needed(target, sd_ep, sigma_s, k):
    floor = Z * math.sqrt(2 * sigma_s ** 2 / k)
    if floor >= target:
        return None
    return math.ceil(sd_ep ** 2 / ((target / Z) ** 2 - 2 * sigma_s ** 2 / k))


need = {}
for target in (20, 30, 40):
    for sigma in (0, 5, 10):
        for k in (3, 5):
            need[f"delta={target},sigma_seed={sigma},k={k}"] = n_needed(target, SDF, sigma, k)
out["episodes_needed_false_per_100"] = {"note": "None = not reachable at any n (seed noise floor)", **need}
out["episodes_needed_recall_delta_0.03"] = {f"sigma_seed={s},k={k}": n_needed(0.03, SDR, s, k)
                                           for s in (0, 0.01, 0.02) for k in (3, 5)}

# calibration-set size: threshold stability proxy
GRID = [None, -0.01, -0.02, -0.05, -0.1, -0.15, -0.2, -0.3, -0.4, -0.5, -0.75, -1.0]
recs = R.records(ROOT / "results/foundation-2026-11/pilot-s1/qwen3-4b-2507", "val", "open")
per = defaultdict(lambda: {str(t): Counter() for t in GRID})
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


cal = {}
for m in (8, 12, 17, 24, 36):
    rng = random.Random(m)
    fp = []
    picks = Counter()
    for _ in range(1000):
        d = [rng.choice(ids) for _ in range(m)]
        best = max(GRID, key=lambda t: (confidence.f_beta(*(agg(d, t)[k] for k in ("tp", "pred_content", "gold_content"))),
                                        -(t if t is not None else 0.0)))
        picks[str(best)] += 1
        full = agg(ids, best)
        fp.append(100 * full["false_memory"] / full["sessions"])
    fp.sort()
    cal[str(m)] = {"tau_modal_share": round(picks.most_common(1)[0][1] / 1000, 2), "tau_distinct": len(picks),
                   "false_per_100_p5_p50_p95": [round(fp[50], 1), round(fp[500], 1), round(fp[949], 1)],
                   "no_threshold_chosen_share": round(picks.get("None", 0) / 1000, 3)}
out["calibration_size_proxy"] = {"note": "4B seed-1 val outputs as a stand-in calibration pool; m > 24 reuses the same 24 episodes",
                                 "by_calibration_episodes": cal}
(HERE / "e2_sample_size.json").write_text(json.dumps(out, indent=1) + "\n")
print(json.dumps(out, indent=1))
