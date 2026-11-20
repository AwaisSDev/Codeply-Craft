#!/usr/bin/env python3
"""Pilot success criteria (EVAL-PLAN A4; PILOT-PROPOSAL §5). Read-only; replays cached closed-loop generations.

A candidate beats the control only when all five hold (95 % paired episode bootstrap, 2,000 resamples, seed 0):
  1. Δ false memories per 100 sessions: upper bound < 0
  2. Δ strict recall: lower bound >= -0.03
  3. Δ equal-volume precision (confidence.equal_volume): lower bound > 0
  4. Δ end-state F1: lower bound > -0.02
  5. point estimates beyond hardware noise: Δ false / 100 < -5 and Δ equal-volume precision > 0.05
Criteria are fixed in EVAL-PLAN A4; this script only computes them.

    python3 foundation-2026-11/pilot/compare_pilot.py <results dir> --control qwen3-1.7b --candidates qwen3-4b-2507 gemma-4-e2b
"""
import argparse
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402

B, SEED = 2000, 0
NOISE_FALSE, NOISE_PREC, RECALL_MARGIN, ENDSTATE_MARGIN = 5.0, 0.05, -0.03, -0.02


def episodes(run):
    """Per episode: strict counts, end-state counts, and every content op as {score, correct, key}."""
    eps = defaultdict(lambda: {"c": Counter(), "state": Counter(), "ops": []})
    for r in R.records(run, "val", "closed"):
        e = eps[r["episode"]]
        e["c"].update(r["counts"])
        pairs, _, _ = D.pairs_of(r["pred"], r["gold"], r["memories"])
        ok = {id(p) for p, g, m in pairs if m}
        content = [o for o in r["pred"] if o["op"] in contract.PERSISTENT_OPS]
        hit = r.get("hit") or {}
        lp = hit.get("logprobs")
        scores = confidence.op_scores(hit.get("answer", hit.get("raw", "")), lp, content) if lp else [None] * len(content)
        for i, (o, s) in enumerate(zip(content, scores)):
            e["ops"].append({"score": s, "correct": id(o) in ok, "key": (r["episode"], r["sid"], i)})
    res = json.loads((Path(run) / "result-val-closed.json").read_text())
    for ep, st in res.get("per_episode_state", {}).items():
        eps[ep]["state"].update(st)
    return eps


def stats(eps, draw):
    c, st, ops = Counter(), Counter(), []
    for j, ep in enumerate(draw):
        c.update(eps[ep]["c"])
        st.update(eps[ep]["state"])
        ops += [{**o, "key": o["key"] + (j,)} for o in eps[ep]["ops"]]
    s = metrics.summarise(c)
    return {"false_per_100": 100 * c["false_memory"] / c["sessions"], "recall": s["extraction_recall"],
            "end_state_f1": metrics.summarise_state(st)["state_f1"] if st else float("nan"), "ops": ops}


def compare(cand, ctrl):
    ids = sorted(set(cand) & set(ctrl))
    full_c, full_k = stats(cand, ids), stats(ctrl, ids)
    ev = confidence.equal_volume(full_c["ops"], full_k["ops"])
    point = {"false_per_100": full_c["false_per_100"] - full_k["false_per_100"], "recall": full_c["recall"] - full_k["recall"],
             "end_state_f1": full_c["end_state_f1"] - full_k["end_state_f1"], "equal_volume_precision": ev["difference"]}
    rng = random.Random(SEED)
    draws = defaultdict(list)
    for _ in range(B):
        d = [rng.choice(ids) for _ in ids]
        a, b = stats(cand, d), stats(ctrl, d)
        for k in ("false_per_100", "recall", "end_state_f1"):
            draws[k].append(a[k] - b[k])
        e = confidence.equal_volume(a["ops"], b["ops"])
        if e["difference"] is not None:
            draws["equal_volume_precision"].append(e["difference"])
    ci = {k: [round(sorted(v)[int(0.025 * len(v))], 4), round(sorted(v)[int(0.975 * len(v)) - 1], 4)] for k, v in draws.items() if v}
    crit = {
        "1_fewer_false_memories": bool(ci["false_per_100"][1] < 0),
        "2_recall_non_inferior": bool(ci["recall"][0] >= RECALL_MARGIN),
        "3_equal_volume_precision": bool("equal_volume_precision" in ci and ci["equal_volume_precision"][0] > 0),
        "4_end_state_not_worse": bool(ci["end_state_f1"][0] > ENDSTATE_MARGIN),
        "5_beyond_hardware_noise": bool(point["false_per_100"] < -NOISE_FALSE and (point["equal_volume_precision"] or 0) > NOISE_PREC),
    }
    return {"episodes": len(ids), "point": {k: (round(v, 4) if v is not None else None) for k, v in point.items()},
            "ci95": ci, "equal_volume": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in ev.items()},
            "criteria": crit, "beats_control": all(crit.values())}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--control", required=True)
    ap.add_argument("--candidates", nargs="+", required=True)
    ap.add_argument("--out", default="")
    a = ap.parse_args(argv)
    root = Path(a.results)
    ctrl = episodes(root / a.control)
    out = {"control": a.control, "bootstrap": {"resamples": B, "seed": SEED, "unit": "episode"},
           "thresholds": {"recall_margin": RECALL_MARGIN, "end_state_margin": ENDSTATE_MARGIN, "noise_false_per_100": NOISE_FALSE,
                          "noise_precision": NOISE_PREC}, "comparisons": {}}
    for c in a.candidates:
        out["comparisons"][c] = compare(episodes(root / c), ctrl)
        r = out["comparisons"][c]
        print(c, "vs", a.control, json.dumps(r["point"]), json.dumps(r["ci95"]), json.dumps(r["criteria"]), "beats:", r["beats_control"])
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
