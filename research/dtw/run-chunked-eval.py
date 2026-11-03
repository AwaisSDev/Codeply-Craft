#!/usr/bin/env python3
"""Run one harness evaluation in chunks so that a container restart loses at most one chunk.

The cloud container this runs in is reclaimed when the session is idle, which killed long evaluations
mid-way several times (KAGGLE-RUNS.md). This splits the set file into chunks of N examples, evaluates each
chunk as its own harness run (skipping chunks already done), then merges the per-example rows into one
details file and recomputes every metric with the harness itself (ml/eval/run.mjs --rescore over the full
set). Latency is recomputed from the per-example times.

  python3 research/dtw/run-chunked-eval.py --name real-lfm3-lora-s1-test-real --provider local:codeply-real-lfm3-lora-s1 \
      --set test-real --set-file research/dtw/data/real/test.jsonl --work <scratch>/chunks [--chunk 50]
"""
import argparse, json, os, shutil, statistics, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = "research/dtw/results"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True); ap.add_argument("--provider", required=True)
    ap.add_argument("--set", required=True); ap.add_argument("--set-file", required=True)
    ap.add_argument("--work", required=True); ap.add_argument("--chunk", type=int, default=50)
    ap.add_argument("--threads", default="4")
    ap.add_argument("--out", default=OUT, help="results folder (default research/dtw/results)")
    ap.add_argument("--extra", default="", help="extra harness arguments, e.g. \"--conf-model <id>\"")
    a = ap.parse_args()
    out = a.out
    if os.path.exists(f"{ROOT}/{out}/{a.name}.json"):
        print(f"{a.name} already done"); return
    rows = open(f"{ROOT}/{a.set_file}").read().strip().split("\n")
    wd = os.path.join(a.work, a.name); os.makedirs(f"{wd}/sets", exist_ok=True)
    parts = []
    for i in range(0, len(rows), a.chunk):
        k = i // a.chunk; pname = f"{a.name}.part{k:03d}"; parts.append(pname)
        if os.path.exists(f"{wd}/{pname}.json"):
            continue
        sf = f"{wd}/sets/{pname}.jsonl"
        open(sf, "w").write("\n".join(rows[i:i + a.chunk]) + "\n")
        print(f"  chunk {k + 1}/{(len(rows) + a.chunk - 1) // a.chunk}", flush=True)
        rc = subprocess.run(["node", "ml/eval/run.mjs", "--provider", a.provider, "--set", a.set, "--set-file", sf,
                             "--threads", a.threads, "--name", pname, "--out", wd] + a.extra.split(), cwd=ROOT,
                            stdout=open(f"{wd}/{pname}.log", "w"), stderr=subprocess.STDOUT).returncode
        if rc or not os.path.exists(f"{wd}/{pname}.json"):
            sys.exit(f"chunk {pname} failed (exit {rc}); see {wd}/{pname}.log; rerun to resume")
    # Merge: all per-example rows into one details file, then the harness rescore over the full set.
    os.makedirs(f"{ROOT}/{out}/details", exist_ok=True)
    with open(f"{ROOT}/{out}/details/{a.name}.jsonl", "w") as fo:
        for p in parts:
            fo.write(open(f"{wd}/details/{p}.jsonl").read().rstrip("\n") + "\n")
    first = json.load(open(f"{wd}/{parts[0]}.json"))
    first["name"] = a.name
    json.dump(first, open(f"{ROOT}/{out}/{a.name}.json", "w"), indent=2)
    rc = subprocess.run(["node", "ml/eval/run.mjs", "--rescore", "--set", a.set, "--set-file", a.set_file,
                         "--name", a.name, "--out", out], cwd=ROOT).returncode
    if rc:
        os.remove(f"{ROOT}/{out}/{a.name}.json"); sys.exit("merge rescore failed")
    r = json.load(open(f"{ROOT}/{out}/{a.name}.json"))
    ms = sorted(json.loads(l)["ms"] for l in open(f"{ROOT}/{out}/details/{a.name}.jsonl"))
    perfs = [json.load(open(f"{wd}/{p}.json")).get("performance", {}) for p in parts]
    r["performance"] = {**perfs[0], "msMean": round(statistics.mean(ms)), "msP50": ms[len(ms) // 2],
                        "msP95": ms[min(len(ms) - 1, int(0.95 * len(ms)))],
                        "wallSeconds": sum(p.get("wallSeconds") or 0 for p in perfs),
                        "serverPeakMB": max((p.get("serverPeakMB") or 0) for p in perfs) or None}
    r["chunked"] = {"chunks": len(parts), "chunkSize": a.chunk, "note": "evaluated in chunks (container restarts); metrics recomputed over the full set by --rescore"}
    json.dump(r, open(f"{ROOT}/{out}/{a.name}.json", "w"), indent=2)
    print(f"{a.name} done: F1 {r['extraction']['f1']}", flush=True)


if __name__ == "__main__":
    main()
