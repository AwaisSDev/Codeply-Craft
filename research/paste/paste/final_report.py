"""Central-test report from results/final/<run>/<file>.json (spec §10.5, EVALUATION-PROTOCOL §6-§8).

* PE and FPM per system: seed-mean over seeds, pooled over the given test files (both wordings of a plan move
  together in the bootstrap: plans are resampled, paste.stats).
* PASTE vs B for B in {M1c, M1c-m}: delta PE, 95 % paired bootstrap CI (10,000 resamples), one-sided p, Holm over
  the two comparisons; the adjusted CI is the Bonferroni 97.5 % CI (conservative; equals Holm's first step).
* FPM non-inferiority: one-sided 95 % upper bound of FPM(PASTE) / FPM(B) <= 1.10.
* M1c+W reading: PE(M1c+W) - PE(PASTE) CI.
* Latency (optional JSON {system: p50_ms at K=32}): PASTE <= 1.5 x M1c.
* Outcome by the table of spec §10.5. Equivalence: both CIs within +-1.0 F1 point.

    python -m paste.final_report --files test-programmatic.jsonl test-api.jsonl [--latency lat.json] --out REPORT.json
"""
import argparse
import collections
import glob
import json
import os
import random

from .final_eval import FINAL, FROZEN_RUNS
from .stats import _fpm, _pe, by_plan, holm, paired_bootstrap


def load(files):
    runs = json.load(open(FROZEN_RUNS))["runs"]
    sys_rows = collections.defaultdict(dict)                    # system -> seed -> rows
    for r in runs:
        rows = []
        for f in files:
            p = os.path.join(FINAL, r["name"], f.replace(".jsonl", ".json"))
            if not os.path.exists(p):
                rows = None
                break
            rows += json.load(open(p))["per_episode"]
        if rows is not None:
            sys_rows[r["system"]][r["seed"]] = rows
    return {s: [d[k] for k in sorted(d)] for s, d in sys_rows.items()}


def ratio_upper(A, B, n=10_000, seed=0, q=0.95):
    """One-sided upper bound of seed-mean FPM(A) / FPM(B), plans resampled jointly."""
    DA, DB = by_plan(A), by_plan(B)
    plans = sorted(set.intersection(*[set(d) for d in DA + DB]))
    sm = lambda D, s: sum(_fpm([r for p in s for r in d[p]]) for d in D) / len(D)
    rng = random.Random(seed)
    boots = sorted(sm(DA, s) / max(1e-9, sm(DB, s)) for s in ([plans[rng.randrange(len(plans))] for _ in plans] for _ in range(n)))
    return sm(DA, plans) / max(1e-9, sm(DB, plans)), boots[int(q * n) - 1]


def ci_level(A, B, level, n=10_000, seed=0):
    DA, DB = by_plan(A), by_plan(B)
    plans = sorted(set.intersection(*[set(d) for d in DA + DB]))
    sm = lambda D, s: sum(_pe([r for p in s for r in d[p]]) for d in D) / len(D)
    rng = random.Random(seed)
    boots = sorted(sm(DA, s) - sm(DB, s) for s in ([plans[rng.randrange(len(plans))] for _ in plans] for _ in range(n)))
    a = (1 - level) / 2
    return boots[int(a * n)], boots[int((1 - a) * n) - 1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", nargs="+", required=True)
    ap.add_argument("--latency", help="JSON {system: p50 ms at K=32}")
    ap.add_argument("--n-boot", type=int, default=10_000)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    S = load(a.files)
    rep = {"files": a.files, "systems": {}, "comparisons": {}}
    for s, seeds in S.items():
        rep["systems"][s] = {"seeds": len(seeds), "PE_seed_mean": round(sum(_pe(x) for x in seeds) / len(seeds), 4),
                             "PE_per_seed": [round(_pe(x), 4) for x in seeds],
                             "FPM_seed_mean": round(sum(_fpm(x) for x in seeds) / len(seeds), 3),
                             "exploratory": len(seeds) < 3}
    pv = {}
    for B in ("M1c", "M1c-m"):
        if "PASTE" in S and B in S:
            d, lo, hi, p_le0 = paired_bootstrap(S["PASTE"], S[B], n=a.n_boot)
            alo, ahi = ci_level(S["PASTE"], S[B], 0.975, n=a.n_boot)
            r, ub = ratio_upper(S["PASTE"], S[B], n=a.n_boot)
            rep["comparisons"][f"PASTE - {B}"] = {"delta_PE": round(d, 4), "ci95": [round(lo, 4), round(hi, 4)],
                                                   "ci_adjusted_97.5": [round(alo, 4), round(ahi, 4)], "p_one_sided": round(p_le0, 4),
                                                   "FPM_ratio": round(r, 3), "FPM_ratio_upper95": round(ub, 3)}
            pv[B] = p_le0
    if pv:
        rej = holm(pv)
        for B in pv:
            rep["comparisons"][f"PASTE - {B}"]["holm_reject_H0"] = rej[B]
    if "PASTE" in S and "M1c+W" in S:
        d, lo, hi, _ = paired_bootstrap(S["M1c+W"], S["PASTE"], n=a.n_boot)
        rep["comparisons"]["M1c+W - PASTE"] = {"delta_PE": round(d, 4), "ci95": [round(lo, 4), round(hi, 4)]}
    lat = json.load(open(a.latency)) if a.latency else None
    lat_ok = None if not lat else lat.get("PASTE", 1e9) <= 1.5 * lat.get("M1c", 0)
    C = [rep["comparisons"].get(f"PASTE - {B}") for B in ("M1c", "M1c-m")]
    if all(C):
        pos = all(c["ci_adjusted_97.5"][0] > 0 for c in C)
        fpm_ok = all(c["FPM_ratio_upper95"] <= 1.10 for c in C)
        if pos and fpm_ok and lat_ok is not False:
            w = rep["comparisons"].get("M1c+W - PASTE")
            outcome = "Pass, but M1c+W >= PASTE" if w and w["ci95"][1] >= 0 else "Pass"
            if lat_ok is None:
                outcome += " (latency criterion not yet measured)"
        elif all(-0.01 <= c["ci95"][0] and c["ci95"][1] <= 0.01 for c in C):
            outcome = "Equivalent"
        elif any(c["ci_adjusted_97.5"][1] < 0 for c in C):
            outcome = "Fail"
        else:
            outcome = "Inconclusive"
        if any(rep["systems"][s]["exploratory"] for s in ("PASTE", "M1c", "M1c-m")):
            outcome += " [exploratory: fewer than 3 seeds]"
        rep["outcome"] = outcome
    json.dump(rep, open(a.out, "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
