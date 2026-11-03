"""Central-test training recipe from validation runs, by the rules pre-registered in DECISIONS.md (2026-11-03,
"recipe decision rules") and CENTRAL-TEST-PLAN.md §2. Validation only; every score is the cross-fitted pooled val PE /
FPM of tools/val_compare.py (theta_W chosen on the other plan fold).

Runs are named GROUP/SYSTEM, SYSTEM in {PASTE, M1c}:
  V0 (teacher forced, = E27 / E26 M1c-hnon; also LR 5e-5 and the 2,000-episode point), V1..V4 (variants), S2 (V0, seed 2,
  PASTE only: seed noise), LR3e-5, LR1e-4, LC1500, LC3000, LC6000, LC3000x2.

Rules (delta = noise allowance = max(0.010, |PE(S2/PASTE) - PE(V0/PASTE)|)):
  variant: score(Vk) = mean over PASTE and M1c of PE. FPM guard: FPM(Vk) <= 1.10 x FPM(V0) for both systems. Eligible:
           passes the guard and score >= best - delta (best over guard-passing variants). Pick from the eligible by preference V1 (spec §6.3 default) > V0 (simplest) > highest score.
  LR:      per family (PASTE; M1c family = M1c, M1c-m, M1c+W, from the M1c runs): 5e-5 unless another LR's PE exceeds it
           by more than delta; then the highest.
  data:    6,000 episodes (the plan's budget). still_improving[sys] = PE(LC6000) - PE(LC3000) > delta. The 3,000 fallback
           (owner, 2026-11-02) is permitted only if PE(LC3000) >= PE(LC6000) - 0.010 for both systems; it is used only if
           the compute budget forces it (recorded as a deviation).
A decision whose runs are missing is reported as "pending" (never guessed).

    python tools/choose_recipe.py --runs V0/PASTE=DIR V0/M1c=DIR V1/PASTE=DIR ... --out recipe.json
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from val_compare import cross_fit, load_sweep, summary  # noqa: E402

SYSTEMS = ("PASTE", "M1c")
VARIANTS = ("V0", "V1", "V2", "V3", "V4")
PREFERENCE = ("V1", "V0")
LRS = {"LR3e-5": 3e-5, "V0": 5e-5, "LR1e-4": 1e-4}


def scores(runs):
    out = {}
    for key, d in runs.items():
        _, rows = cross_fit(load_sweep(d))
        s = summary(rows)
        out[key] = {"PE": s["PE"], "FPM": s["FPM"]}
    return out


def noise(sc):
    if "S2/PASTE" in sc and "V0/PASTE" in sc:
        return round(max(0.010, abs(sc["S2/PASTE"]["PE"] - sc["V0/PASTE"]["PE"])), 4), "measured"
    return 0.010, "floor (S2 pending)"


def choose_variant(sc, delta):
    need = [f"{v}/{s}" for v in VARIANTS for s in SYSTEMS]
    missing = [k for k in need if k not in sc]
    if missing:
        return {"decision": "pending", "missing": missing}
    score = {v: round(sum(sc[f"{v}/{s}"]["PE"] for s in SYSTEMS) / 2, 4) for v in VARIANTS}
    fpm_ok = {v: all(sc[f"{v}/{s}"]["FPM"] <= 1.10 * sc[f"V0/{s}"]["FPM"] for s in SYSTEMS) for v in VARIANTS}
    best = max(score[v] for v in VARIANTS if fpm_ok[v])                # V0 always passes its own guard
    eligible = [v for v in VARIANTS if score[v] >= best - delta and fpm_ok[v]]
    pick = next((v for v in PREFERENCE if v in eligible), None) or max(eligible, key=lambda v: (score[v], v))
    return {"decision": pick, "score_mean_PE": score, "fpm_ok": fpm_ok, "eligible": eligible, "best": best}


def choose_lr(sc, delta):
    out = {}
    for s in SYSTEMS:
        keys = [k for k in LRS if f"{k}/{s}" in sc]
        if len(keys) < len(LRS):
            out[s] = {"decision": "pending", "missing": [f"{k}/{s}" for k in LRS if k not in keys]}
            continue
        pe = {LRS[k]: sc[f"{k}/{s}"]["PE"] for k in keys}
        best = max(pe, key=lambda lr: (pe[lr], lr == 5e-5))
        pick = best if pe[best] > pe[5e-5] + delta else 5e-5
        out[s] = {"decision": pick, "PE": {f"{k:g}": v for k, v in pe.items()}}
    return out


def choose_data(sc, delta):
    pts = {"LC1500": 1500, "V0": 2000, "LC3000": 3000, "LC6000": 6000, "LC3000x2": "3000x2"}
    curve = {s: {str(n): sc[f"{k}/{s}"] for k, n in pts.items() if f"{k}/{s}" in sc} for s in SYSTEMS}
    if not all(f"{k}/{s}" in sc for k in ("LC3000", "LC6000") for s in SYSTEMS):
        return {"decision": "pending", "curve": curve}
    gain = {s: round(sc[f"LC6000/{s}"]["PE"] - sc[f"LC3000/{s}"]["PE"], 4) for s in SYSTEMS}
    return {"decision": 6000, "curve": curve, "gain_6000_minus_3000": gain,
            "still_improving": {s: gain[s] > delta for s in SYSTEMS},
            "fallback_3000_permitted": all(g <= 0.010 for g in gain.values())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="+", required=True, help="GROUP/SYSTEM=RUN_DIR")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    runs = dict(x.split("=", 1) for x in a.runs)
    sc = scores(runs)
    delta, how = noise(sc)
    res = {"scores": sc, "delta": delta, "delta_source": how, "variant": choose_variant(sc, delta),
           "lr": choose_lr(sc, delta), "data": choose_data(sc, delta)}
    json.dump(res, open(a.out, "w"), indent=1)
    print(json.dumps({k: res[k] for k in ("delta", "delta_source")}))
    print("variant:", json.dumps(res["variant"]))
    print("lr:", json.dumps(res["lr"]))
    print("data:", json.dumps({k: v for k, v in res["data"].items() if k != "curve"}))


if __name__ == "__main__":
    main()
