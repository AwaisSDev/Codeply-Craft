#!/usr/bin/env python3
"""Manual-inspection sample of zero-shot Qwen3-4B-Instruct-2507 false memories (wave A, closed loop, val). Read-only.
Stratified by report_run.classify category, random.Random(20261120); writes inspect_4b_sample.jsonl.

    cd research/iris && python3 foundation-2026-11/pilot/inspect_4b.py
"""
import json, random, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(ROOT / "audit-r4"))
import report_run as R
import diagnose as D
from codeply_iris import contract
from codeply_iris.store import same_value

QUOTA = {"same statement, different value / slot": 10, "same value, different entity": 8, "statement the teacher did not label": 8,
         "stored a skip trap": 8, "same statement, date wrong or missing": 6, "other speaker's statement attributed to the user": 2}

def main():
    recs = R.records(ROOT / "results" / "foundation-2026-11" / "qwen3-4b-2507", "val", "closed")
    pool = {k: [] for k in QUOTA}
    for r in recs:
        _, up, _ = D.pairs_of(r["pred"], r["gold"], r["memories"])
        for p in up:
            if any(contract.norm(m["ent"]) == contract.norm(p["ent"]) and same_value(m["val"], p["val"], m.get("when"), p.get("when")) for m in r["memories"]):
                continue
            cat = R.classify(p, r)
            if cat in pool:
                msg = r["messages"][p["src"] - 1]
                pool[cat].append({"session": r["id"], "lang": r["lang"], "source": r["source"], "category": cat,
                                  "message": {"n": p["src"], "who": msg["who"], "text": msg["text"]},
                                  "pred": {k: p.get(k) for k in ("op", "ent", "attr", "val", "when", "evid", "ref", "conf") if p.get(k) is not None},
                                  "gold_same_message": [{k: g.get(k) for k in ("op", "ent", "attr", "val", "when", "evid", "why") if g.get(k) is not None}
                                                        for g in r["gold"] if g["src"] == p["src"]],
                                  "store_rows": len(r["memories"])})
    rng = random.Random(20261120)
    out = []
    for cat, n in QUOTA.items():
        items = sorted(pool[cat], key=lambda x: (x["session"], x["pred"]["evid"], str(x["pred"].get("val"))))
        for i, it in enumerate(rng.sample(items, min(n, len(items))), 1):
            out.append({"item": f"{cat.split(',')[0].split()[0]}-{cat.split()[-1]}-{i:02d}", "population": len(items), **it})
    (HERE / "inspect_4b_sample.jsonl").write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in out))
    print({k: (min(QUOTA[k], len(v)), len(v)) for k, v in pool.items()})

if __name__ == "__main__":
    main()
