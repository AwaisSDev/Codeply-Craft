#!/usr/bin/env python3
"""Operating-point calibration, as pre-registered in research/dtw/CALIBRATION-PROTOCOL.md.

For one trained DtW run:
  1. val  : run the harness once on the frozen val split with both knobs off (the provider records
            p.span and p.gate per observation in the raw answer);
  2. grid : for every (gate, span) threshold pair, drop the observations below it from the stored raw
            answers and rescore through the harness itself (ml/eval/run.mjs --rescore: same guard, same
            matching); cost C_r = r*FP + FN on memorable observations, r in {2, 3, 5};
  3. pick : per r, the cheapest point (ties: lower thresholds);
  4. test : run test-real, Benchmark-520 and natural-300 once with the knobs off (confidences
            recorded), then apply each chosen point by the same filter + rescore, saved as
            <name>-<set>-cal<r>. Filtering stored answers equals running the provider with the flags:
            the knobs only drop observations after decoding.
Nothing from the test sets, Benchmark-520 or natural-300 is used to choose anything.

  python3 research/dtw/calibrate.py --run <dir> --name dtw-real-ettin400-s1 [--threads 4]
"""
import argparse, json, os, shutil, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RES = "research/dtw/results"
CAL = f"{RES}/calibration"
SETS = {"val": "research/dtw/data/real/val.jsonl", "test-real": "research/dtw/data/real/test.jsonl",
        "bench": "research/dtw/benchmark/bench.jsonl", "natural": "research/dtw/label/data/fullnat.jsonl"}
GATES = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
SPANS = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]
RATIOS = [2, 3, 5]
PRIMARY = 3


def sh(cmd, log):
    with open(log, "w") as fh:
        return subprocess.run(cmd, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT).returncode


def run(a, name, set_name, out):
    """Harness run with both knobs off (records confidences)."""
    if os.path.exists(f"{ROOT}/{out}/{name}.json"):
        return
    os.makedirs(f"{ROOT}/{out}", exist_ok=True)
    rc = sh(["node", "ml/eval/run.mjs", "--provider", "module:research/dtw/runtime/dtw-provider.mjs", "--dtw-run", a.run,
             "--set", set_name, "--set-file", SETS[set_name], "--threads", str(a.threads), "--name", name, "--out", out],
            f"{a.work}/{name}.log")
    if rc:
        sys.exit(f"{name}: harness exit {rc}; see {a.work}/{name}.log")


def filtered(src_out, name, gate, span, dst_out, dst_name, set_name):
    """Copy a stored run with the observations below (gate, span) removed, then rescore it."""
    os.makedirs(f"{ROOT}/{dst_out}/details", exist_ok=True)
    shutil.copy(f"{ROOT}/{src_out}/{name}.json", f"{ROOT}/{dst_out}/{dst_name}.json")
    with open(f"{ROOT}/{src_out}/details/{name}.jsonl") as fi, open(f"{ROOT}/{dst_out}/details/{dst_name}.jsonl", "w") as fo:
        for line in fi:
            row = json.loads(line)
            try:
                ans = json.loads(row["raw"])
            except Exception:
                ans = None
            if isinstance(ans, dict) and "observations" in ans:
                ans["observations"] = [o for o in ans["observations"]
                                       if (o.get("p") or {}).get("gate", 1) >= gate and (o.get("p") or {}).get("span", 1) >= span]
                row["raw"] = json.dumps(ans)
            fo.write(json.dumps(row) + "\n")
    rc = sh(["node", "ml/eval/run.mjs", "--rescore", "--set", set_name, "--set-file", SETS[set_name],
             "--name", dst_name, "--out", dst_out], f"/tmp/rescore-{os.getpid()}.log")
    if rc:
        sys.exit(f"rescore {dst_name} failed")
    return json.load(open(f"{ROOT}/{dst_out}/{dst_name}.json"))


def fragments(out, name):
    """Share of predicted memorable observations whose value is one word or only stopwords."""
    stop = set("the a an and or to of in on at for with my me i is are was be it this that we our you your from by as up so do not no im".split())
    tot = frag = 0
    for line in open(f"{ROOT}/{out}/details/{name}.jsonl"):
        for o in json.loads(line)["predicted"]:
            if o.get("certainty") not in ("stated", "implied", "temporary"):
                continue
            w = [x for x in str(o.get("value", "")).lower().replace(",", " ").split() if x]
            tot += 1
            frag += len(w) <= 1 or all(x in stop for x in w)
    return {"memorable": tot, "fragments": frag, "share": round(frag / tot, 3) if tot else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--work", default="/tmp/calibrate")
    ap.add_argument("--sets", default="test-real,bench,natural")
    a = ap.parse_args()
    a.run = os.path.abspath(a.run)
    os.makedirs(a.work, exist_ok=True)

    # 1-3: val, grid, pick
    vname = f"cal-{a.name}-val"
    run(a, vname, "val", CAL)
    grid = []
    for g in GATES:
        for s in SPANS:
            r = filtered(CAL, vname, g, s, os.path.relpath(a.work, ROOT), "grid", "val")
            e = r["extraction"]
            fp, fn = e["pred"] - e["tp"], e["gold"] - e["tp"]
            grid.append({"gate": g, "span": s, "tp": e["tp"], "pred": e["pred"], "gold": e["gold"], "fp": fp, "fn": fn,
                         "precision": e["precision"], "recall": e["recall"], "f1": e["f1"],
                         "noiseRejection": r.get("noiseRejection"), **{f"cost{k}": k * fp + fn for k in RATIOS}})
    pick = {}
    for k in RATIOS:
        best = min(grid, key=lambda x: (x[f"cost{k}"], x["gate"] + x["span"]))
        pick[k] = {"gate": best["gate"], "span": best["span"], "val": best}
    summary = {"name": a.name, "run": os.path.basename(a.run), "protocol": "research/dtw/CALIBRATION-PROTOCOL.md",
               "valExamples": None, "grid": grid, "chosen": pick, "fragmentsVal": fragments(CAL, vname)}
    summary["valExamples"] = json.load(open(f"{ROOT}/{CAL}/{vname}.json")).get("examples")
    json.dump(summary, open(f"{ROOT}/{CAL}/{a.name}-operating-points.json", "w"), indent=1)
    print(a.name, "val chosen:", {k: (v["gate"], v["span"], v["val"]["precision"], v["val"]["recall"], v["val"]["f1"]) for k, v in pick.items()}, flush=True)

    # 4: test sets, once per chosen point
    for set_name in a.sets.split(","):
        rname = f"cal-{a.name}-{set_name}"
        run(a, rname, set_name, CAL)
        summary.setdefault("fragments", {})[set_name] = fragments(CAL, rname)
        for k in RATIOS:
            p = pick[k]
            r = filtered(CAL, rname, p["gate"], p["span"], RES, f"{a.name}-{set_name}-cal{k}", set_name)
            r["operatingPoint"] = {"gate": p["gate"], "span": p["span"], "costRatio": k, "chosenOn": "val",
                                   "protocol": "research/dtw/CALIBRATION-PROTOCOL.md"}
            json.dump(r, open(f"{ROOT}/{RES}/{a.name}-{set_name}-cal{k}.json", "w"), indent=2)
            e = r["extraction"]
            print(f"  {set_name} cal{k}: F1 {e['f1']} P {e['precision']} R {e['recall']} falseMem {r.get('falseMemoryRate')}", flush=True)
    json.dump(summary, open(f"{ROOT}/{CAL}/{a.name}-operating-points.json", "w"), indent=1)


if __name__ == "__main__":
    main()
