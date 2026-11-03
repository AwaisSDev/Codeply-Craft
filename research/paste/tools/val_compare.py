"""Compare runs on validation from their `tools/val_sweep.py` sweeps (validation only).

* **Cross-fitted threshold.** Val plans are split into two folds by a hash of the plan id (both wordings of a plan
  are in the same fold). theta_W is chosen on one fold (minimise 3*FP + FN, protocol §5) and the other fold is
  scored at it, then the folds swap. Every episode is scored at a threshold chosen without it.
* **Reported per run:** cross-fitted PE / FPM / precision / recall / per-op F1, per val file and pooled; the
  thresholds chosen per fold (threshold transfer); the in-sample full-val choice and the analytic theta_W = 0.5.
* **Pairs:** 95 % paired bootstrap over plans (paste.stats, 10,000 resamples) of the cross-fitted PE and FPM.

    python tools/val_compare.py --runs NAME=RUN_DIR ... [--pairs A:B ...] --out OUT.json
"""
import argparse
import collections
import glob
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from paste.stats import OPS, _fpm, _pe, paired_bootstrap, plan_id  # noqa: E402


def fold(pid):
    return int(hashlib.sha1(pid.encode()).hexdigest(), 16) % 2


def load_sweep(run, sub="sweep"):
    out = {}
    for p in sorted(glob.glob(os.path.join(run, sub, "th*.json"))):
        d = json.load(open(p))
        rows = []
        for name, per in d["files"].items():
            rows += [dict(r, _file=name) for r in per]
        out[d["theta_W"]] = rows
    if not out:
        raise SystemExit(f"no sweep in {run}/{sub}")
    return out


def cost(rows, c=3.0):
    fp = sum(sum(r["fp"].get(k, 0) for k in OPS) for r in rows)
    fn = sum(sum(r["fn"].get(k, 0) for k in OPS) for r in rows)
    return c * fp + fn


def summary(rows):
    tp = collections.Counter(); fp = collections.Counter(); fn = collections.Counter()
    for r in rows:
        tp.update(r["tp"]); fp.update(r["fp"]); fn.update(r["fn"])
    T, P, N = sum(tp[k] for k in OPS), sum(fp[k] for k in OPS), sum(fn[k] for k in OPS)
    f1 = lambda t, p, n: round(2 * t / (2 * t + p + n), 4) if t + p + n else None
    return {"PE": round(_pe(rows), 4), "FPM": round(_fpm(rows), 3),
            "precision": round(T / (T + P), 4) if T + P else None, "recall": round(T / (T + N), 4) if T + N else None,
            "per_op_f1": {k: f1(tp[k], fp[k], fn[k]) for k in OPS}, "episodes": len(rows)}


def cross_fit(sweep):
    ths = sorted(sweep)
    chosen, rows = {}, []
    for f in (0, 1):
        train = {th: [r for r in sweep[th] if fold(plan_id(r["id"])) != f] for th in ths}
        best = min(ths, key=lambda th: (cost(train[th]), th))
        chosen[f] = best
        rows += [r for r in sweep[best] if fold(plan_id(r["id"])) == f]
    return chosen, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True, help="NAME=RUN_DIR")
    ap.add_argument("--pairs", nargs="*", default=[], help="A:B (delta = A - B)")
    ap.add_argument("--sub", default="sweep")
    ap.add_argument("--n-boot", type=int, default=10_000)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    runs = dict(x.split("=", 1) for x in a.runs)
    res, cf_rows = {"runs": {}, "pairs": {}}, {}
    for name, d in runs.items():
        sw = load_sweep(d, a.sub)
        chosen, rows = cross_fit(sw)
        cf_rows[name] = rows
        full_best = min(sorted(sw), key=lambda th: (cost(sw[th]), th))
        files = sorted({r["_file"] for r in rows})
        res["runs"][name] = {
            "dir": d, "grid": sorted(sw), "crossfit_theta_by_fold": chosen,
            "crossfit": summary(rows), "crossfit_by_file": {f: summary([r for r in rows if r["_file"] == f]) for f in files},
            "insample_theta": full_best, "insample": summary(sw[full_best]),
            "theta_0.5": summary(sw[0.5]) if 0.5 in sw else None,
            "by_theta": {th: {k: v for k, v in summary(sw[th]).items() if k in ("PE", "FPM", "precision", "recall")} for th in sorted(sw)}}
        print(name, json.dumps({"crossfit": res["runs"][name]["crossfit"]["PE"], "FPM": res["runs"][name]["crossfit"]["FPM"],
                                "theta": chosen}), flush=True)
    for pr in a.pairs:
        A, B = pr.split(":")
        out = {}
        for metric in ("PE", "FPM"):
            dl, lo, hi, p = paired_bootstrap([cf_rows[A]], [cf_rows[B]], metric=metric, n=a.n_boot)
            out[metric] = {"delta": round(dl, 4), "ci95": [round(lo, 4), round(hi, 4)], "p_one_sided_le0": round(p, 4)}
        res["pairs"][f"{A} - {B}"] = out
        print(pr, json.dumps(out), flush=True)
    json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
