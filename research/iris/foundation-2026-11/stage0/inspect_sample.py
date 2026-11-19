#!/usr/bin/env python3
"""Draw the manual-inspection sample of false memories (foundation study, stage 0). Read-only, seeded.

Source: Iris 1.7B r3, open loop, validation (the provisional lead; committed details file). Every unmatched
predicted content op is classified with failure_analysis.taxonomy's rule, then a fixed number is drawn per
category with random.Random(20261119). For each item the sample keeps the cited message, the prediction, and every
gold op on the same message, so a reader can judge it without opening other files.

    cd research/iris && python3 foundation-2026-11/stage0/inspect_sample.py   # writes inspect_sample.jsonl
"""
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
from codeply_iris import contract, metrics  # noqa: E402
from codeply_iris.store import same_value  # noqa: E402

RUN = "iris-1.7b-r3"
QUOTA = {"unlabelled": 25, "entity": 20, "near_value": 20, "attribution": 9, "trap": 4}
SEED = 20261119


def category(p, r):
    cat = D.classify_false(p, r["gold"], r["messages"], r["memories"])
    if cat.startswith("stored a labelled skip"):
        return "trap"
    if cat.startswith("statement the teacher did not label"):
        return "unlabelled"
    if cat.startswith("other speaker"):
        return "attribution"
    if cat.startswith("quote from an assistant"):
        return "assistant"
    g = max((g for g in r["gold"] if g["op"] in contract.PERSISTENT_OPS and g["src"] == p["src"]
             and metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5),
            key=lambda g: metrics.value_sim(p.get("val", ""), g.get("val", "")))
    ent_ok = contract.norm(metrics.resolve_entity(p["ent"], [g["ent"]]) or p["ent"]) == contract.norm(g["ent"])
    val_ok = metrics.content_score(p, g) > 0
    return "entity" if (val_ok and not ent_ok) else "near_value"


def main():
    pool = {k: [] for k in QUOTA}
    for r in D.open_records(RUN):
        _, up, _ = D.pairs_of(r["pred"], r["gold"], r["memories"])
        for p in up:
            if any(contract.norm(m["ent"]) == contract.norm(p["ent"]) and same_value(m["val"], p["val"], m.get("when"), p.get("when"))
                   for m in r["memories"]):
                continue                                      # restatement of a stored memory: not a false memory
            cat = category(p, r)
            if cat not in pool:
                continue
            msg = r["messages"][p["src"] - 1]
            pool[cat].append({
                "session": r["id"], "lang": r["lang"], "source": r["source"], "label_source": "Opus" if r["episode"].startswith("va01") else "Sonnet",
                "category": cat, "message": {"n": p["src"], "who": msg["who"], "text": msg["text"]},
                "pred": {k: p.get(k) for k in ("op", "ent", "attr", "val", "when", "kind", "evid", "ref") if p.get(k) is not None},
                "gold_same_message": [{k: g.get(k) for k in ("op", "ent", "attr", "val", "when", "evid", "why", "ref") if g.get(k) is not None}
                                      for g in r["gold"] if g["src"] == p["src"]],
                "memories_shown": len(r["memories"])})
    rng = random.Random(SEED)
    out = []
    for cat, n in QUOTA.items():
        items = sorted(pool[cat], key=lambda x: (x["session"], x["pred"]["evid"], x["pred"]["val"]))
        pick = rng.sample(items, min(n, len(items)))
        for i, it in enumerate(pick, 1):
            out.append({"item": f"{cat}-{i:02d}", "population": len(items), **it})
    with (HERE / "inspect_sample.jsonl").open("w", encoding="utf-8") as f:
        for it in out:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    print({k: (min(QUOTA[k], len(v)), len(v)) for k, v in pool.items()})


if __name__ == "__main__":
    main()
