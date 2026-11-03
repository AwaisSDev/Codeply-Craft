#!/usr/bin/env python3
"""Tier selection for the memory model, as pre-registered in release/memory-model/TIERS.md.

  select : val only. For f in {exist, mean, min} and r in {2, 3, 5}: tauA = lowest grid value whose automatic-tier
           val precision >= r/(r+1); tauP = lowest grid value < tauA whose pending-band val precision >= 1/3.
           Feature: the one whose automatic tier keeps the most correct memories at r = 3 (ties: exist, mean, min).
           Writes results/TIERS-FROZEN.json (commit it before `test`).
  test   : the frozen thresholds on test-real and Benchmark-520, once.
Every number comes from the evaluation harness (ml/eval/run.mjs --rescore on filtered copies of the stored answers).

  python3 release/memory-model/select_tiers.py select --seed 1
  python3 release/memory-model/select_tiers.py test --seed 1
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RES = "release/memory-model/results"
SETS = {"val": "research/dtw/data/real/val.jsonl", "test-real": "research/dtw/data/real/test.jsonl", "bench": "research/dtw/benchmark/bench.jsonl"}
GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99]
FEATURES = ["exist", "mean", "min"]
RATIOS = [2, 3, 5]
RHO = 1 / 3
WORK = tempfile.mkdtemp(prefix="tiers-rel-")
N = 0


def conf(o, f):
    p = o.get("p") or {}
    v = p.get(f)
    return v if isinstance(v, (int, float)) else 1.0  # no confidence: treated as automatic, as in production


def rescore(src, set_name, keep):
    """Harness metrics after keeping only the observations for which keep(o) is true."""
    global N
    N += 1
    name = f"r{N}"
    os.makedirs(f"{WORK}/details", exist_ok=True)
    shutil.copy(f"{ROOT}/{RES}/{src}.json", f"{WORK}/{name}.json")
    with open(f"{ROOT}/{RES}/details/{src}.jsonl") as fi, open(f"{WORK}/details/{name}.jsonl", "w") as fo:
        for line in fi:
            row = json.loads(line)
            try:
                ans = json.loads(row["raw"])
            except Exception:
                ans = None
            if isinstance(ans, dict) and isinstance(ans.get("observations"), list):
                ans["observations"] = [o for o in ans["observations"] if isinstance(o, dict) and keep(o)]
                row["raw"] = json.dumps(ans)
            fo.write(json.dumps(row) + "\n")
    rc = subprocess.run(["node", "ml/eval/run.mjs", "--rescore", "--set", set_name, "--set-file", SETS[set_name],
                         "--name", name, "--out", WORK], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    if rc:
        sys.exit(f"rescore failed for {src}")
    r = json.load(open(f"{WORK}/{name}.json"))
    e = r["extraction"]
    return {"tp": e["tp"], "pred": e["pred"], "gold": e["gold"], "precision": e["precision"], "recall": e["recall"], "f1": e["f1"],
            "falseMemoryRate": r.get("falseMemoryRate"), "examples": r.get("examples")}


def tiers_at(src, set_name, f, ta, tp):
    a = rescore(src, set_name, lambda o: conf(o, f) >= ta)
    u = rescore(src, set_name, lambda o: conf(o, f) >= tp)
    fp, fn = a["pred"] - a["tp"], a["gold"] - a["tp"]
    bp, bt = u["pred"] - a["pred"], u["tp"] - a["tp"]
    return {"automatic": a, "automaticOrPending": {"tp": u["tp"], "pred": u["pred"], "recall": u["recall"]},
            "pending": {"items": bp, "per100inputs": round(100 * bp / max(1, a["examples"] or 1), 1), "precision": round(bt / bp, 3) if bp else None, "extraGold": bt},
            "cost": {f"C{r}": r * fp + fn for r in RATIOS}, "storeNothingCost": a["gold"]}


def select(seed):
    src = f"release-s{seed}-val"
    auto = {f: {t: rescore(src, "val", lambda o, f=f, t=t: conf(o, f) >= t) for t in GRID} for f in FEATURES}
    choice = {}
    for r in RATIOS:
        floor = r / (r + 1)
        per = {}
        for f in FEATURES:
            ok = [t for t in GRID if auto[f][t]["pred"] and auto[f][t]["precision"] >= floor]
            ta = min(ok) if ok else None
            tp = None
            top = ta if ta is not None else 1.01
            base = auto[f][ta] if ta is not None else {"tp": 0, "pred": 0}
            for t in [t for t in GRID if t < top]:
                bp, bt = auto[f][t]["pred"] - base["pred"], auto[f][t]["tp"] - base["tp"]
                if bp and bt / bp >= RHO:
                    tp = t
                    break
            per[f] = {"tauA": ta, "tauP": tp, "valAutoTp": base["tp"]}
        choice[r] = per
    best = max(FEATURES, key=lambda f: (choice[3][f]["valAutoTp"], -FEATURES.index(f)))
    frozen = {"seed": seed, "feature": best, "protocol": "release/memory-model/TIERS.md", "chosenOn": "val",
              "byRatio": {f"r={r}": {"tauA": choice[r][best]["tauA"], "tauP": choice[r][best]["tauP"]} for r in RATIOS}}
    val = {f"r={r}": tiers_at(src, "val", best, choice[r][best]["tauA"] if choice[r][best]["tauA"] is not None else 1.01,
                               choice[r][best]["tauP"] if choice[r][best]["tauP"] is not None else (choice[r][best]["tauA"] or 1.01)) for r in RATIOS}
    json.dump({"grid": {f: {str(t): auto[f][t] for t in GRID} for f in FEATURES}, "perFeature": {f"r={r}": choice[r] for r in RATIOS}, "frozen": frozen, "valAtChoice": val},
              open(f"{ROOT}/{RES}/tiers-s{seed}-val-selection.json", "w"), indent=1)
    path = f"{ROOT}/{RES}/TIERS-FROZEN.json"
    allf = json.load(open(path)) if os.path.exists(path) else {}
    if f"s{seed}" in allf:
        sys.exit(f"seed {seed} already frozen; not overwritten")
    allf[f"s{seed}"] = frozen
    json.dump(allf, open(path, "w"), indent=1, sort_keys=True)
    for r in RATIOS:
        v = val[f"r={r}"]
        print(f"s{seed} r={r} {best} tauA={frozen['byRatio'][f'r={r}']['tauA']} tauP={frozen['byRatio'][f'r={r}']['tauP']} | val auto P {v['automatic']['precision']} R {v['automatic']['recall']} | pending {v['pending']} | C {v['cost']} vs nothing {v['storeNothingCost']}")


def test(seed):
    path = f"{ROOT}/{RES}/TIERS-FROZEN.json"
    fz = (json.load(open(path)) if os.path.exists(path) else {}).get(f"s{seed}")
    if not fz:
        sys.exit("no frozen tiers for this seed")
    clean = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", f"{RES}/TIERS-FROZEN.json"], cwd=ROOT).returncode == 0
    tracked = subprocess.run(["git", "ls-files", "--error-unmatch", f"{RES}/TIERS-FROZEN.json"], cwd=ROOT, capture_output=True).returncode == 0
    if not (clean and tracked):
        sys.exit("commit TIERS-FROZEN.json before testing")
    out = {"frozen": fz, "byRatio": {}}
    for s in ("test-real", "bench"):
        src = f"release-s{seed}-{s}"
        for k, c in fz["byRatio"].items():
            ta = c["tauA"] if c["tauA"] is not None else 1.01
            tp = c["tauP"] if c["tauP"] is not None else ta
            res = tiers_at(src, s, fz["feature"], ta, tp)
            out["byRatio"].setdefault(k, {})[s] = res
            a = res["automatic"]
            print(f"s{seed} {s} {k}: auto P {a['precision']} R {a['recall']} F1 {a['f1']} | pending {res['pending']} | C {res['cost']} vs nothing {a['gold']}")
    json.dump(out, open(f"{ROOT}/{RES}/tiers-s{seed}-test.json", "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["select", "test"])
    ap.add_argument("--seed", type=int, required=True)
    a = ap.parse_args()
    select(a.seed) if a.phase == "select" else test(a.seed)
    shutil.rmtree(WORK, ignore_errors=True)
