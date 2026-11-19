#!/usr/bin/env python3
"""Wave-A summary and the pre-registered selection rule (EVAL-PLAN §5, §7; amendments A1-A2). Read-only.

For every system under results/foundation-2026-11/<system>/ (Kaggle T4 runs), the closed- and open-loop records are
replayed from the cached generations (report_run.records), counted per episode, and compared with zero-shot
Qwen3-1.7B (prompt v1.1) by a paired cluster bootstrap over the 24 val episodes (2,000 resamples, seed 0):

  Δ false memories per 100 sessions (closed)   qualifies when the 95 % interval's upper bound <= 0
  Δ P@60 (closed)  or  Δ F0.5 (closed)          qualifies when the 95 % interval's lower bound > 0

Also reported: strict P / R / F1 (open, closed), end-state, output validity, cap-hit rate (900 tokens), think leaks,
language slices, and, when present, the CPU-vs-GPU hardware noise for Qwen3-1.7B (stage1-kaggle/hw-noise-cpu).

    python3 foundation-2026-11/summarize_wave_a.py      # writes foundation-2026-11/WAVE-A-RESULTS.json
"""
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402

RES = ROOT / "results" / "foundation-2026-11"
BASE = "qwen3-1.7b"
SYSTEMS = ["qwen3.5-2b", "gemma-4-e2b", "qwen3-4b-2507", "qwen3-1.7b", "qwen3-0.6b", "qwen3-1.7b-v1", "qwen3-0.6b-v1"]
K = 60
B = 2000


def per_episode(recs):
    eps = defaultdict(lambda: {"c": Counter(), "scored": []})
    for r in recs:
        e = eps[r["episode"]]
        e["c"].update(r["counts"])
        e["scored"] += R.scored_ops(r, r.get("hit"))
    return eps


def stats(eps, ids):
    c, scored = Counter(), []
    for i in ids:
        c.update(eps[i]["c"])
        scored += eps[i]["scored"]
    n = c["sessions"]
    p_at = confidence.precision_at_k(scored, K) if any(s is not None for s, _ in scored) else None
    return {"false_per_100": 100 * c["false_memory"] / n if n else None,
            "f0_5": confidence.f_beta(c["tp"], c["pred_content"], c["gold_content"]),
            "p_at_k": p_at}


def boot(a_eps, b_eps, rng):
    ids = sorted(set(a_eps) & set(b_eps))
    draws = defaultdict(list)
    for _ in range(B):
        s = [rng.choice(ids) for _ in ids]
        x, y = stats(a_eps, s), stats(b_eps, s)
        for k in x:
            if x[k] is not None and y[k] is not None:
                draws[k].append(x[k] - y[k])
    ci = {}
    for k, v in draws.items():
        v.sort()
        ci[k] = [round(v[int(0.025 * len(v))], 3), round(v[int(0.975 * len(v)) - 1], 3)] if len(v) >= 100 else None
    return ci


def cap_hits(run):
    p = run / "preds-val-closed.jsonl"
    rows = [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []
    obs = [r for r in rows if r.get("finish_reason")]
    return round(sum(r["finish_reason"] == "length" for r in obs) / len(obs), 3) if obs else None


def main():
    out = {"base": BASE, "k": K, "bootstrap": {"resamples": B, "seed": 0, "unit": "episode"}, "systems": {}}
    recs_closed = {s: R.records(RES / s, "val", "closed") for s in SYSTEMS if (RES / s / "preds-val-closed.jsonl").exists()}
    eps_closed = {s: per_episode(r) for s, r in recs_closed.items()}
    rng = random.Random(0)
    for s in SYSTEMS:
        run = RES / s
        if not (run / "preds-val-open.jsonl").exists():
            continue
        row = {}
        for loop in ("open", "closed"):
            if (run / f"preds-val-{loop}.jsonl").exists():
                recs = recs_closed[s] if loop == "closed" else R.records(run, "val", "open")
                rep = R.report(recs, K)
                row[loop] = {"primary": rep["primary"], "strict": {k: rep["strict"].get(k) for k in (
                    "extraction_precision", "extraction_recall", "extraction_f1", "false_memory_share", "output_validity",
                    "update_accuracy", "skip_recall", "hard_negative_stored", "ungrounded_evidence_rate")},
                    "taxonomy": rep["false_memory_taxonomy"], "think": rep["think"],
                    "language": {k: v["extraction_f1"] for k, v in rep["slices"]["language"].items()}}
        res = run / "result-val-closed.json"
        if res.exists():
            row["closed_end_state"] = json.loads(res.read_text()).get("end_state")
        row["cap_hit_rate_closed"] = cap_hits(run)
        if s != BASE and s in eps_closed and BASE in eps_closed:
            ci = boot(eps_closed[s], eps_closed[BASE], rng)
            row["vs_base_closed_ci95"] = ci
            fm, pk, f5 = ci.get("false_per_100"), ci.get("p_at_k"), ci.get("f0_5")
            row["qualifies"] = bool(fm and fm[1] <= 0 and ((pk and pk[0] > 0) or (f5 and f5[0] > 0)))
        out["systems"][s] = row
    noise = HERE / "stage1-kaggle" / "hw-noise-cpu" / BASE
    if (noise / "preds-val-open.jsonl").exists() and (RES / BASE / "preds-val-open.jsonl").exists():
        a, b = R.report(R.records(noise, "val", "open"), K), R.report(R.records(RES / BASE, "val", "open"), K)
        out["hardware_noise_open_qwen3_1.7b"] = {
            "cpu": {**a["primary"], "f1": a["strict"]["extraction_f1"]}, "gpu": {**b["primary"], "f1": b["strict"]["extraction_f1"]}}
    (HERE / "WAVE-A-RESULTS.json").write_text(json.dumps(out, indent=1, default=str) + "\n")
    for s, row in out["systems"].items():
        c = row.get("closed", {})
        print(f"{s:14s} closed F1 {c.get('strict', {}).get('extraction_f1')} P {c.get('strict', {}).get('extraction_precision')} "
              f"false/100 {c.get('primary', {}).get('false_memories_per_100_sessions')} P@{K} {c.get('primary', {}).get(f'precision_at_{K}')} "
              f"F0.5 {c.get('primary', {}).get('f0_5')} cap {row.get('cap_hit_rate_closed')} qualifies {row.get('qualifies')}")


if __name__ == "__main__":
    main()
