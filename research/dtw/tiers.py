#!/usr/bin/env python3
"""Fragment filtering + three-tier storage, as pre-registered in research/dtw/TIERS-PROTOCOL.md.

  select : val only. For decoders F0/F1/F2 and r in {2,3,5}: tau_a = lowest grid value whose automatic-tier
           val precision >= r/(r+1); tau_p = lowest grid value < tau_a whose pending-band val precision >= rho
           (rho = 1/3 primary; 0.25 and 0.5 reported); decoder = most automatic true positives (ties: simpler).
           Writes the choice into research/dtw/results/tiers/FROZEN.json (one entry per model).
  test   : only for a model already in FROZEN.json (committed first); applies the frozen configuration to the
           recorded test runs (calibration/cal-<model>-<set>) and writes research/dtw/results/tiers/<model>-<set>.json.
Every number comes from the harness itself (ml/eval/run.mjs --rescore on filtered copies of stored answers).

  python3 research/dtw/tiers.py select --name dtw-real-ettin150-s1
  python3 research/dtw/tiers.py test   --name dtw-real-ettin150-s1
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CAL = "research/dtw/results/calibration"
OUT = "research/dtw/results/tiers"
SETS = {"val": "research/dtw/data/real/val.jsonl", "test-real": "research/dtw/data/real/test.jsonl",
        "bench": "research/dtw/benchmark/bench.jsonl", "natural": "research/dtw/label/data/fullnat.jsonl"}
GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
RATIOS = [2, 3, 5]
RHOS = [1 / 3, 0.25, 0.5]
DECODERS = ["F0", "F1", "F2"]
MEMORABLE = {"stated", "implied", "temporary"}
STOP = set("the a an and or to of in on at for with my me i is are was be it this that we our you your from by as up so do not no im".split())
WORK = tempfile.mkdtemp(prefix="tiers-")
N = 0


def words(o):
    return [x for x in str(o.get("value", "")).lower().replace(",", " ").split() if x]


def keep_decoder(o, dec):
    if dec == "F0" or o.get("certainty") not in MEMORABLE:
        return True
    w = words(o)
    if dec == "F1":
        return not (len(w) <= 1 or all(x in STOP for x in w))
    return sum(1 for x in w if x not in STOP) >= 2  # F2


def q(o):
    p = o.get("p") or {}
    return p.get("gate", 1) * p.get("span", 1)


def rescore(src, set_name, keep):
    """Harness metrics after keeping only observations for which keep(o) is true."""
    global N
    N += 1
    name = f"r{N}"
    os.makedirs(f"{WORK}/details", exist_ok=True)
    shutil.copy(f"{ROOT}/{CAL}/{src}.json", f"{WORK}/{name}.json")
    with open(f"{ROOT}/{CAL}/details/{src}.jsonl") as fi, open(f"{WORK}/details/{name}.jsonl", "w") as fo:
        for line in fi:
            row = json.loads(line)
            try:
                ans = json.loads(row["raw"])
            except Exception:
                ans = None
            if isinstance(ans, dict) and "observations" in ans:
                ans["observations"] = [o for o in ans["observations"] if keep(o)]
                row["raw"] = json.dumps(ans)
            fo.write(json.dumps(row) + "\n")
    rc = subprocess.run(["node", "ml/eval/run.mjs", "--rescore", "--set", set_name, "--set-file", SETS[set_name],
                         "--name", name, "--out", WORK], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if rc:
        sys.exit(f"rescore failed for {src}")
    r = json.load(open(f"{WORK}/{name}.json"))
    r["_details"] = [json.loads(l) for l in open(f"{WORK}/details/{name}.jsonl")]
    return r


def ex(r):
    e = r["extraction"]
    return {"tp": e["tp"], "pred": e["pred"], "gold": e["gold"], "precision": e["precision"], "recall": e["recall"], "f1": e["f1"],
            "falseMemoryRate": r.get("falseMemoryRate"), "noiseRejection": r.get("noiseRejection"), "examples": r.get("examples")}


def tiers_metrics(src, set_name, dec, ta, tp, subset=None):
    """Automatic tier, automatic ∪ pending, pending band, costs."""
    def k_auto(o): return keep_decoder(o, dec) and q(o) >= ta
    def k_union(o): return keep_decoder(o, dec) and q(o) >= tp
    a, u = rescore(src, set_name, k_auto), rescore(src, set_name, k_union)
    if subset is not None:  # recompute on a subset of example ids from the per-example rows
        def agg(r):
            rows = [x for x in r["_details"] if x["id"] in subset]
            t, p, g = sum(x["tp"] for x in rows), sum(x["pred"] for x in rows), sum(x["gold"] for x in rows)
            P = t / p if p else 0; R = t / g if g else 0
            return {"tp": t, "pred": p, "gold": g, "precision": round(P, 3), "recall": round(R, 3), "f1": round(2 * t / (g + p), 3) if g + p else 0, "examples": len(rows)}
        A, U = agg(a), agg(u)
    else:
        A, U = ex(a), ex(u)
    band_pred, band_tp = U["pred"] - A["pred"], U["tp"] - A["tp"]
    fp, fn = A["pred"] - A["tp"], A["gold"] - A["tp"]
    return {"automatic": A, "automaticOrPending": {k: U[k] for k in ("tp", "pred", "recall")},
            "pending": {"items": band_pred, "per100inputs": round(100 * band_pred / max(1, A["examples"] or 1), 1),
                        "precision": round(band_tp / band_pred, 3) if band_pred else None, "extraGold": band_tp},
            "cost": {f"C{r}": r * fp + fn for r in RATIOS}, "storeNothingCost": A["gold"]}


def select(name):
    src = f"cal-{name}-val"
    res = {"model": name, "protocol": "research/dtw/TIERS-PROTOCOL.md", "chosenOn": "val", "decoders": {}}
    auto = {}
    for dec in DECODERS:
        auto[dec] = {}
        for ta in GRID:
            r = ex(rescore(src, "val", lambda o, d=dec, t=ta: keep_decoder(o, d) and q(o) >= t))
            auto[dec][ta] = r
        res["decoders"][dec] = {str(t): auto[dec][t] for t in GRID}
    choice = {}
    for r_ in RATIOS:
        floor = r_ / (r_ + 1)
        best = None
        for dec in DECODERS:
            ok = [t for t in GRID if auto[dec][t]["pred"] and auto[dec][t]["precision"] >= floor]
            ta = min(ok) if ok else None
            tp_auto = auto[dec][ta]["tp"] if ta is not None else 0
            if best is None or tp_auto > best["valAutoTp"]:
                best = {"decoder": dec, "tauA": ta, "valAutoTp": tp_auto}
        dec, ta = best["decoder"], best["tauA"]
        entry = {**best, "precisionFloor": round(floor, 3), "tauP": {}}
        top = ta if ta is not None else 1.01
        for rho in RHOS:
            chosen = None
            for tp in [t for t in GRID if t < top]:
                u = auto[dec][tp]; a = auto[dec][ta] if ta is not None else {"tp": 0, "pred": 0}
                bp, bt = u["pred"] - a["pred"], u["tp"] - a["tp"]
                if bp and bt / bp >= rho:
                    chosen = tp
                    break
            entry["tauP"][f"rho={rho:.2f}"] = chosen
        entry["valAtChoice"] = tiers_metrics(src, "val", dec, ta if ta is not None else 1.01,
                                             entry["tauP"]["rho=0.33"] if entry["tauP"]["rho=0.33"] is not None else (ta if ta is not None else 1.01))
        choice[f"r={r_}"] = entry
    res["choice"] = choice
    os.makedirs(f"{ROOT}/{OUT}", exist_ok=True)
    json.dump(res, open(f"{ROOT}/{OUT}/{name}-val-selection.json", "w"), indent=1)
    fz = f"{ROOT}/{OUT}/FROZEN.json"
    frozen = json.load(open(fz)) if os.path.exists(fz) else {}
    if name in frozen:
        sys.exit(f"{name} is already frozen; not overwritten")
    frozen[name] = {k: {"decoder": v["decoder"], "tauA": v["tauA"], "tauP": v["tauP"]} for k, v in choice.items()}
    json.dump(frozen, open(fz, "w"), indent=1, sort_keys=True)
    for k, v in choice.items():
        A = v["valAtChoice"]["automatic"]
        print(f"{name} {k}: {v['decoder']} tauA={v['tauA']} tauP={v['tauP']} | val auto P {A['precision']} R {A['recall']} "
              f"tp {A['tp']}/{A['gold']} | pending {v['valAtChoice']['pending']} | C {v['valAtChoice']['cost']} vs nothing {v['valAtChoice']['storeNothingCost']}", flush=True)


def test(name, sets):
    fz = f"{ROOT}/{OUT}/FROZEN.json"
    frozen = json.load(open(fz)).get(name) if os.path.exists(fz) else None
    if not frozen:
        sys.exit(f"{name}: no frozen configuration; run select and commit FROZEN.json first")
    tracked = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", f"{OUT}/FROZEN.json"], cwd=ROOT).returncode == 0 and \
        subprocess.run(["git", "ls-files", "--error-unmatch", f"{OUT}/FROZEN.json"], cwd=ROOT, capture_output=True).returncode == 0
    if not tracked:
        sys.exit("FROZEN.json has uncommitted changes; commit it before testing")
    U = json.load(open(f"{ROOT}/research/dtw/label/audit/user-overlap-ids.json"))
    for s in sets:
        out = {"model": name, "set": s, "frozen": frozen, "protocol": "research/dtw/TIERS-PROTOCOL.md", "byRatio": {}}
        for k, c in frozen.items():
            ta = c["tauA"] if c["tauA"] is not None else 1.01
            tp = c["tauP"]["rho=0.33"] if c["tauP"]["rho=0.33"] is not None else ta
            out["byRatio"][k] = {"F0sameTiers": tiers_metrics(f"cal-{name}-{s}", s, "F0", ta, tp),
                                 "chosen": tiers_metrics(f"cal-{name}-{s}", s, c["decoder"], ta, tp)}
            if s == "test-real":
                ids = set(U["test-real"]["wildchatUserNotInTrain"] + U["test-real"]["notWildchat"])
                out["byRatio"][k]["chosenUserDisjoint"] = tiers_metrics(f"cal-{name}-{s}", s, c["decoder"], ta, tp, subset=ids)
            A = out["byRatio"][k]["chosen"]["automatic"]
            print(f"{name} {s} {k}: auto P {A['precision']} R {A['recall']} F1 {A['f1']} | pending {out['byRatio'][k]['chosen']['pending']} | "
                  f"C {out['byRatio'][k]['chosen']['cost']} vs nothing {A['gold']}", flush=True)
        json.dump(out, open(f"{ROOT}/{OUT}/{name}-{s}.json", "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["select", "test"])
    ap.add_argument("--name", required=True)
    ap.add_argument("--sets", default="test-real,bench,natural")
    a = ap.parse_args()
    select(a.name) if a.phase == "select" else test(a.name, a.sets.split(","))
    shutil.rmtree(WORK, ignore_errors=True)
