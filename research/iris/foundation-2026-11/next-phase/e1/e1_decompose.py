#!/usr/bin/env python3
"""E1 analysis (E1-PROTOCOL §4-§5), written before any E1 result existed. Read-only; replays cached generations.

Per cell: strict P / R / F1, false memories / 100 sessions, P@60, F0.5, valid output, cap hits, end-state F1 (closed),
the M3 behaviour counts (no-store sessions, skips on labelled facts / skips), content-op volume.
Decomposition (open loop F1, false / 100, recall; 95 % paired episode bootstrap, 2,000 resamples, seed 0):
  G  = F(r2,T) - F(p,Q4C)                    total gap
  S  = F(p,T)  - F(p,Q4C)                    pilot stack share = backend + quantisation + constraint
       backend      F(p,T) - F(p,F16U);  quantisation F(p,F16U) - F(p,Q4U);  constraint F(p,Q4U) - F(p,Q4C)
  Tr = F(r2,T) - F(p,T)                      recipe bundle (confounded: data, epochs, template, checkpoint)
  DiD = [F(r2,T) - F(r2,Q4C)] - [F(p,T) - F(p,Q4C)]   stack x adapter interaction
  plus the same three components for r2.
Closed loop: G, S, Tr from cells 13-16 (components not split).
Pre-registered readings: stack-dominated (S/G >= 0.5 and S lower bound > 0), recipe-dominated (Tr/G >= 0.5, Tr lower
bound > 0, and S's interval includes 0 or S < 0.03), else mixed; a component is material if its interval excludes 0
and |dF1| >= 0.03 or |d false/100| >= 10. Missing or failed cells make the affected quantities "not computable".
Exploratory cells X1 / X2 are listed separately and never enter the decomposition.

    python3 foundation-2026-11/next-phase/e1/e1_decompose.py <e1 results dir> [--out E1-DECOMPOSITION.json]
"""
import argparse, json, math, random, sys
from collections import Counter, defaultdict
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "foundation-2026-11")); sys.path.insert(0, str(ROOT / "audit-r4"))
import report_run as R  # noqa: E402
from codeply_iris import confidence, contract, metrics  # noqa: E402

B, SEED = 2000, 0
OPEN = ["r2-T", "r2-F16U", "r2-F16C", "r2-Q4U", "r2-Q4C", "p-T", "p-F16U", "p-F16C", "p-Q4U", "p-Q4C", "r3-T", "r3-Q4C"]
CLOSED = ["r2-T", "r2-Q4C", "p-T", "p-Q4C"]
EXPLORATORY = ["X1-p-Q4C-nothink", "X2-r2-Q4C-think"]
MATERIAL_F1, MATERIAL_FALSE, RECIPE_SMALL = 0.03, 10.0, 0.03


def load(d, loop):
    p = Path(d) / f"result-val-{loop}.json"
    if not p.exists():
        return None
    res = json.loads(p.read_text())
    if res["metrics"].get("n_sessions") != 120:
        return None
    recs = R.records(Path(d), "val", loop)
    eps = defaultdict(Counter)
    beh = Counter()
    for r in recs:
        eps[r["episode"]].update(r["counts"])
        beh["no_store_op"] += not [o for o in r["pred"] if o["op"] != "skip"]
        for o in r["pred"]:
            if o["op"] != "skip":
                continue
            beh["skips"] += 1
            beh["skip_on_labelled_fact"] += any(g["op"] in contract.PERSISTENT_OPS and g["src"] == o["src"] and
                                                metrics.evid_overlap(o["evid"], g["evid"]) >= 0.5 for g in r["gold"])
            beh["skip_on_labelled_skip"] += any(g["op"] == "skip" and g["src"] == o["src"] and
                                                metrics.evid_overlap(o["evid"], g["evid"]) >= 0.5 for g in r["gold"])
    rep = R.report(recs, 60)
    m = res["metrics"]
    cap = sum(1 for r in recs if (r.get("hit") or {}).get("new_tokens", 0) >= 900)
    cell = {"precision": m["extraction_precision"], "recall": m["extraction_recall"], "f1": m["extraction_f1"],
            "false_per_100": m["false_memories_per_100_sessions"], "valid_output": m["output_validity"],
            "content_ops": m["n_pred_content"], "cap_hits": cap,
            "p_at_60": rep.get("primary", {}).get("precision_at_60"), "f0_5": rep.get("primary", {}).get("f0_5"),
            "logprobs_available": any((r.get("hit") or {}).get("logprobs") for r in recs),
            "behaviour": dict(beh)}
    if loop == "open":
        cell["retrieval_f1"] = m.get("retrieval_f1")
    if loop == "closed":
        cell["end_state_f1"] = res.get("end_state", {}).get("state_f1")
        st = res.get("per_episode_state", {})
    else:
        st = {}
    if cell["p_at_60"] is None and not cell["logprobs_available"]:
        cell["p_at_60"] = "N/A (no log-probabilities)"
    return {"cell": cell, "eps": eps, "state": {k: Counter(v) for k, v in st.items()}}


def agg(e, draw):
    c = Counter()
    for ep in draw:
        c.update(e["eps"][ep])
    s = metrics.summarise(c)
    return {"f1": s["extraction_f1"], "recall": s["extraction_recall"], "precision": s["extraction_precision"],
            "false_per_100": 100 * c["false_memory"] / c["sessions"]}


EXPRS = {   # name: [(coef, cell)]
    "G": [(1, "r2-T"), (-1, "p-Q4C")],
    "S_pilot": [(1, "p-T"), (-1, "p-Q4C")],
    "pilot_backend": [(1, "p-T"), (-1, "p-F16U")],
    "pilot_quantisation": [(1, "p-F16U"), (-1, "p-Q4U")],
    "pilot_constraint": [(1, "p-Q4U"), (-1, "p-Q4C")],
    "Tr_recipe": [(1, "r2-T"), (-1, "p-T")],
    "S_r2": [(1, "r2-T"), (-1, "r2-Q4C")],
    "r2_backend": [(1, "r2-T"), (-1, "r2-F16U")],
    "r2_quantisation": [(1, "r2-F16U"), (-1, "r2-Q4U")],
    "r2_constraint": [(1, "r2-Q4U"), (-1, "r2-Q4C")],
    "constraint_at_F16_pilot": [(1, "p-F16U"), (-1, "p-F16C")],
    "constraint_at_F16_r2": [(1, "r2-F16U"), (-1, "r2-F16C")],
    "DiD_stack_x_adapter": [(1, "r2-T"), (-1, "r2-Q4C"), (-1, "p-T"), (1, "p-Q4C")],
}
CLOSED_EXPRS = {k: EXPRS[k] for k in ("G", "S_pilot", "Tr_recipe", "S_r2", "DiD_stack_x_adapter")}


def ci(v):
    v = sorted(x for x in v if x == x)
    return [round(v[int(0.025 * len(v))], 4), round(v[int(0.975 * len(v)) - 1], 4)] if v else None


def decompose(cells, exprs):
    need = {c for terms in exprs.values() for _, c in terms}
    have = {c for c in need if cells.get(c)}
    ids = sorted(set.intersection(*[set(cells[c]["eps"]) for c in have])) if have else []
    rng = random.Random(SEED)
    draws = [[rng.choice(ids) for _ in ids] for _ in range(B)] if ids else []
    out = {}
    for name, terms in exprs.items():
        if not all(cells.get(c) for _, c in terms):
            out[name] = {"status": "not computable", "missing": [c for _, c in terms if not cells.get(c)]}
            continue
        rec = {}
        for metric in ("f1", "false_per_100", "recall"):
            pt = sum(k * agg(cells[c], ids)[metric] for k, c in terms)
            bs = [sum(k * agg(cells[c], d)[metric] for k, c in terms) for d in draws]
            rec[metric] = {"point": round(pt, 4), "ci95": ci(bs), "_draws": bs}
        out[name] = rec
    for share, num in (("S_over_G", "S_pilot"), ("Tr_over_G", "Tr_recipe")):
        if "f1" in out.get(num, {}) and "f1" in out.get("G", {}):
            g, n = out["G"]["f1"], out[num]["f1"]
            pt = n["point"] / g["point"] if g["point"] else float("nan")
            bs = [a / b for a, b in zip(n["_draws"], g["_draws"]) if b]
            out[share] = {"point": round(pt, 3), "ci95": ci(bs), "note": "ratio per resample; unstable if G's interval approaches 0"}
    for v in out.values():
        for m in ("f1", "false_per_100", "recall"):
            if isinstance(v, dict) and m in v:
                v[m].pop("_draws", None)
    return out, len(ids)


def material(rec):
    if "f1" not in rec:
        return None
    f, fm = rec["f1"], rec["false_per_100"]
    excl = lambda c: c and (c[0] > 0 or c[1] < 0)   # noqa: E731
    return bool((excl(f["ci95"]) and abs(f["point"]) >= MATERIAL_F1) or (excl(fm["ci95"]) and abs(fm["point"]) >= MATERIAL_FALSE))


def reading(d):
    if any("f1" not in d.get(k, {}) for k in ("G", "S_pilot", "Tr_recipe")):
        return "not computable"
    S, Tr = d["S_pilot"]["f1"], d["Tr_recipe"]["f1"]
    s_g, tr_g = d.get("S_over_G", {}).get("point"), d.get("Tr_over_G", {}).get("point")
    if s_g is not None and s_g >= 0.5 and S["ci95"][0] > 0:
        return "stack-dominated"
    if tr_g is not None and tr_g >= 0.5 and Tr["ci95"][0] > 0 and (S["ci95"][0] <= 0 <= S["ci95"][1] or S["point"] < RECIPE_SMALL):
        return "recipe-dominated"
    return "mixed"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    root = Path(a.results)
    out = {"bootstrap": {"resamples": B, "seed": SEED, "unit": "episode"}, "cells": {"open": {}, "closed": {}, "exploratory": {}}}
    opn = {c: load(root / c, "open") for c in OPEN}
    cls = {c: load(root / c, "closed") for c in CLOSED}
    exp = {c: load(root / c, "open") for c in EXPLORATORY}
    for grp, cells in (("open", opn), ("closed", cls), ("exploratory", exp)):
        for c, v in cells.items():
            out["cells"][grp][c] = v["cell"] if v else "missing / failed / incomplete"
    for grp, cells in (("closed", cls),):
        for c, v in cells.items():
            if v and v["state"]:
                st = Counter()
                for x in v["state"].values():
                    st.update(x)
                out["cells"][grp][c]["end_state_f1"] = metrics.summarise_state(st)["state_f1"]
    d_open, n_open = decompose(opn, EXPRS)
    d_closed, n_closed = decompose(cls, CLOSED_EXPRS)
    for d in (d_open, d_closed):
        for k, v in d.items():
            if isinstance(v, dict) and "f1" in v and k not in ("G",):
                v["material"] = material(v)
    out["decomposition_open"] = {"episodes": n_open, **d_open}
    out["decomposition_closed"] = {"episodes": n_closed, **d_closed}
    ro, rc = reading(d_open), reading(d_closed)
    out["reading"] = {"open": ro, "closed": rc, "label": ro if ro == rc else ("mixed" if "not computable" not in (ro, rc) else ro)}
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1, default=str) + "\n")
    print(json.dumps({"reading": out["reading"],
                      "open": {k: (v.get("f1", v) if isinstance(v, dict) else v) for k, v in d_open.items()},
                      "closed": {k: (v.get("f1", v) if isinstance(v, dict) else v) for k, v in d_closed.items()}}, indent=1, default=str))


if __name__ == "__main__":
    main()
