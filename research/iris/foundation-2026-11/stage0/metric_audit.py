#!/usr/bin/env python3
"""Audit of the strict IrisBench matcher against a manual reading of false memories (stage 0). Read-only.

1. Tallies the manual verdicts (inspect_labels.json, sample drawn by inspect_sample.py from Iris 1.7B r3 open loop)
   and scales them to the full population of each category.
2. Defines two relaxed matchers as *secondary diagnostics* (the strict matcher stays primary, IRISBENCH §3-4):
     entity_relaxed   a predicted content op that value-matches a gold content op on the same message
                      (metrics.content_score > 0) counts even when the entity differs
     evidence_anchored  any predicted content op whose quote overlaps an unclaimed gold content op on the same
                      message (evid_overlap >= 0.5) counts, whatever the value
   and measures, on the manual sample, how often each relaxed acceptance is a real paraphrase of the gold fact
   (verdict NAMING or EQUIVALENT): the matcher's precision and recall as a judge.
3. Re-scores every committed run (open loop) with the strict, entity-relaxed and evidence-anchored rules.

    cd research/iris && python3 foundation-2026-11/stage0/metric_audit.py   # writes metric_audit.json
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
from codeply_iris import contract, metrics  # noqa: E402
from codeply_iris.store import same_value  # noqa: E402

RUNS = ["iris-0.6b-r2", "iris-1.7b-r2", "iris-0.6b-r3", "iris-1.7b-r3"]
GROUPS = {
    "correct fact, same as a gold fact (metric penalty)": {"NAMING", "EQUIVALENT"},
    "correct, memory-worthy, not labelled (label omission)": {"OMISSION", "CORRECT_OTHER_SLOT"},
    "partly right": {"PARTIAL"},
    "true but not worth storing": {"TRIVIAL", "DIFFERENT_TRUE"},
    "should have confirmed a stored memory": {"DUPLICATE_SHOULD_CONFIRM"},
    "stored a skip trap": {"TRAP_STORED"},
    "wrong: invented, misread, misattributed": {"WRONG", "WRONG_ENTITY", "WRONG_VALUE"},
}
WORTHY = {"NAMING", "EQUIVALENT"}


def group_of(v):
    return next(g for g, s in GROUPS.items() if v in s)


def relaxed_accepts(p, r):
    """Which relaxed rules would turn this unmatched prediction into a true positive (open loop, one session)."""
    pairs, up, ug = D.pairs_of(r["pred"], r["gold"], r["memories"])
    free = [g for g in ug if g["src"] == p["src"]]
    ent = any(metrics.content_score(p, g) > 0 for g in free)
    evid = any(metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5 for g in free)
    return {"entity_relaxed": ent, "evidence_anchored": evid}


def rescore(recs, rule):
    """Open-loop P / R / F1 when unmatched predictions are paired greedily with unmatched gold under `rule`."""
    tp = pred = gold = 0
    for r in recs:
        pairs, up, ug = D.pairs_of(r["pred"], r["gold"], r["memories"])
        strict = sum(1 for _, _, ok in pairs if ok)
        extra, used = 0, set()
        if rule != "strict":
            for p in up:
                if any(contract.norm(m["ent"]) == contract.norm(p["ent"]) and same_value(m["val"], p["val"], m.get("when"), p.get("when"))
                       for m in r["memories"]):
                    continue
                for j, g in enumerate(ug):
                    if j in used or g["src"] != p["src"]:
                        continue
                    ok = metrics.content_score(p, g) > 0 if rule == "entity_relaxed" else metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5
                    if ok:
                        used.add(j)
                        extra += 1
                        break
        tp += strict + extra
        pred += sum(1 for o in r["pred"] if o["op"] in contract.PERSISTENT_OPS)
        gold += sum(1 for o in r["gold"] if o["op"] in contract.PERSISTENT_OPS)
    p, rc = tp / pred if pred else float("nan"), tp / gold
    return {"precision": round(p, 3), "recall": round(rc, 3), "f1": round(2 * p * rc / (p + rc), 3) if tp else 0.0, "tp": tp, "pred": pred, "gold": gold}


def main():
    sample = [json.loads(l) for l in (HERE / "inspect_sample.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    labels = json.loads((HERE / "inspect_labels.json").read_text(encoding="utf-8"))["verdicts"]
    out = {"sample": {"run": "iris-1.7b-r3", "loop": "open", "n": len(sample)}}

    # 1. tallies, by sampled category and scaled to the population of that category
    by_cat = defaultdict(Counter)
    pop = {}
    for it in sample:
        by_cat[it["category"]][labels[it["item"]]["verdict"]] += 1
        pop[it["category"]] = it["population"]
    est = Counter()
    for cat, c in by_cat.items():
        n = sum(c.values())
        for v, k in c.items():
            est[group_of(v)] += pop[cat] * k / n
    total = sum(pop.values())
    out["verdicts_by_category"] = {cat: {"sampled": sum(c.values()), "population": pop[cat], **dict(c.most_common())} for cat, c in by_cat.items()}
    out["population_estimate"] = {g: {"false_memories": round(v, 1), "share": round(v / total, 3)} for g, v in est.most_common()}
    out["population_estimate"]["total_false_memories"] = total

    # 2. relaxed matchers as judges, on the sampled items
    recs = {r["id"]: r for r in D.open_records("iris-1.7b-r3")}
    judge = {}
    for rule in ("entity_relaxed", "evidence_anchored"):
        acc_w = acc_n = worthy_n = 0
        wrong_accepted = []
        for it in sample:
            r = recs[it["session"]]
            p = next(o for o in r["pred"] if o["op"] in contract.PERSISTENT_OPS and o["evid"] == it["pred"]["evid"]
                     and o.get("val") == it["pred"].get("val") and o["ent"] == it["pred"]["ent"])
            a = relaxed_accepts(p, r)[rule]
            w = labels[it["item"]]["verdict"] in WORTHY
            acc_n += a
            acc_w += a and w
            worthy_n += w
            if a and not w:
                wrong_accepted.append(f"{it['item']}: {labels[it['item']]['verdict']}")
        judge[rule] = {"accepted": acc_n, "accepted_and_same_fact": acc_w, "same_fact_in_sample": worthy_n,
                       "precision_as_judge": round(acc_w / acc_n, 3) if acc_n else None,
                       "recall_as_judge": round(acc_w / worthy_n, 3) if worthy_n else None,
                       "accepted_but_not_same_fact": wrong_accepted}
    out["relaxed_matchers_vs_manual"] = judge

    # 3. every run, open loop, three rules
    out["rescored_open"] = {run: {rule: rescore(D.open_records(run), rule) for rule in ("strict", "entity_relaxed", "evidence_anchored")}
                            for run in RUNS}
    (HERE / "metric_audit.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({k: out[k] for k in ("population_estimate", "relaxed_matchers_vs_manual")}, indent=1, ensure_ascii=False))
    for run, v in out["rescored_open"].items():
        print(run, {k: (x["precision"], x["recall"], x["f1"]) for k, x in v.items()})


if __name__ == "__main__":
    main()
