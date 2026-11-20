#!/usr/bin/env python3
"""E1 EXPLORATORY analysis, written AFTER the E1 results were seen (not pre-registered). Read-only.

Why: every Transformers (T) cell crashed (peft refused to build LoRA layers: torchao 0.10.0 in the Kaggle image), so the
pre-registered G / S / Tr decomposition is "not computable" (E1-DECOMPOSITION.json). This script substitutes the
nearest measured setup, GGUF F16 unconstrained (F16U), for the missing T anchor, and adds cross-run comparisons with
the committed historical r2 / r3 Transformers results. None of this replaces the pre-registered analysis; every number
here is labelled exploratory, and the backend effect (T vs F16U) stays unmeasured in E1.

    python3 foundation-2026-11/next-phase/e1/e1_exploratory.py results/foundation-2026-11/e1 --out E1-EXPLORATORY.json
"""
import argparse, json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import e1_decompose as D  # noqa: E402

ROOT = HERE.parents[2]
HIST = {"hist-r2-T": ROOT / "results/gpu-r2/val/iris-1.7b-r2", "hist-r3-T": ROOT / "results/gpu-r2/val/iris-1.7b-r3"}
OPEN_X = {
    "Gprime_r2F16U_minus_pQ4C": [(1, "r2-F16U"), (-1, "p-Q4C")],
    "Sprime_pilot_F16U_to_Q4C": [(1, "p-F16U"), (-1, "p-Q4C")],
    "recipe_at_F16U": [(1, "r2-F16U"), (-1, "p-F16U")],
    "recipe_at_F16C": [(1, "r2-F16C"), (-1, "p-F16C")],
    "recipe_at_Q4U": [(1, "r2-Q4U"), (-1, "p-Q4U")],
    "recipe_at_Q4C": [(1, "r2-Q4C"), (-1, "p-Q4C")],
    "DiD_quantisation_r2_minus_pilot": [(1, "r2-F16U"), (-1, "r2-Q4U"), (-1, "p-F16U"), (1, "p-Q4U")],
    "cross_run_histT_minus_r2F16U": [(1, "hist-r2-T"), (-1, "r2-F16U")],
    "cross_run_histT_minus_r2Q4C": [(1, "hist-r2-T"), (-1, "r2-Q4C")],
    "cross_run_hist_r3T_minus_r3Q4C": [(1, "hist-r3-T"), (-1, "r3-Q4C")],
    "cross_run_histG_r2T_minus_pQ4C": [(1, "hist-r2-T"), (-1, "p-Q4C")],
}
CLOSED_X = {
    "recipe_at_Q4C": [(1, "r2-Q4C"), (-1, "p-Q4C")],
    "cross_run_histT_minus_r2Q4C": [(1, "hist-r2-T"), (-1, "r2-Q4C")],
    "cross_run_histG_r2T_minus_pQ4C": [(1, "hist-r2-T"), (-1, "p-Q4C")],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    root = Path(a.results)
    opn = {c: D.load(root / c, "open") for c in D.OPEN if c not in ("r2-T", "p-T", "r3-T")}
    cls = {c: D.load(root / c, "closed") for c in ("r2-Q4C", "p-Q4C")}
    for k, p in HIST.items():
        opn[k] = D.load(p, "open")
    cls["hist-r2-T"] = D.load(HIST["hist-r2-T"], "closed")
    do, n_o = D.decompose(opn, OPEN_X)
    dc, n_c = D.decompose(cls, CLOSED_X)
    if "f1" in do.get("Gprime_r2F16U_minus_pQ4C", {}) and "f1" in do.get("Sprime_pilot_F16U_to_Q4C", {}):
        # share of G' carried by the pilot's F16U -> Q4C stack (point only; the ratio CI needs the draws, recomputed here)
        import random
        ids = sorted(set(opn["r2-F16U"]["eps"]) & set(opn["p-Q4C"]["eps"]) & set(opn["p-F16U"]["eps"]))
        rng = random.Random(D.SEED)
        rat = []
        for _ in range(D.B):
            d = [rng.choice(ids) for _ in ids]
            g = D.agg(opn["r2-F16U"], d)["f1"] - D.agg(opn["p-Q4C"], d)["f1"]
            s = D.agg(opn["p-F16U"], d)["f1"] - D.agg(opn["p-Q4C"], d)["f1"]
            if g:
                rat.append(s / g)
        g0 = do["Gprime_r2F16U_minus_pQ4C"]["f1"]["point"]
        do["Sprime_over_Gprime"] = {"point": round(do["Sprime_pilot_F16U_to_Q4C"]["f1"]["point"] / g0, 3) if g0 else None, "ci95": D.ci(rat)}
    out = {"status": "EXPLORATORY, written after the results; not pre-registered; does not replace E1-DECOMPOSITION.json",
           "substitution": "GGUF F16 unconstrained stands in for the missing Transformers anchor; backend effect unmeasured",
           "cross_run_note": "hist-* are the committed historical Transformers results (different run, environment and date); differences mix backend, run and environment",
           "bootstrap": {"resamples": D.B, "seed": D.SEED, "unit": "episode"},
           "open": {"episodes": n_o, **do}, "closed": {"episodes": n_c, **dc}}
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1, default=str) + "\n")
    for grp in ("open", "closed"):
        for k, v in out[grp].items():
            if isinstance(v, dict) and "f1" in v:
                print(grp, k, "F1", v["f1"]["point"], v["f1"]["ci95"], "| false", v["false_per_100"]["point"], v["false_per_100"]["ci95"],
                      "| recall", v["recall"]["point"], v["recall"]["ci95"])
            elif isinstance(v, dict):
                print(grp, k, v)


if __name__ == "__main__":
    main()
