"""Which kind of mistake does the current model make?

From an evaluation run's per-example details (ml/results/details/*.jsonl)
and the dataset's gold targets, counts errors by what would fix them:

  decision errors   a label among a few options was wrong: memorable or not
                    (false memories, noise kept, gold missed), kind,
                    certainty, plan vs observation
  merge errors      the brain took a different action than with the gold
                    observations (slot naming against known memories)
  generation errors a value, slot or date that is wrong text
  format errors     unparseable output (grammar should make this 0)

  python3 -I failure_taxonomy.py <details.jsonl> <set.jsonl>
"""
import json
import sys
from collections import Counter

MEMORABLE = {"stated", "implied", "temporary"}


def main():
    det = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8")]
    gold = {}
    for l in open(sys.argv[2], encoding="utf-8"):
        e = json.loads(l)
        gold[e["id"]] = e
    c = Counter()
    fp_cert = Counter()
    for r in det:
        g = gold.get(r["id"])
        if not g:
            continue
        c["examples"] += 1
        if not r["ok"]:
            c["format: unparseable"] += 1
            continue
        tp, gm, pm = r["tp"], r["gold"], r["pred"]
        c["gold memorable"] += gm
        c["predicted memorable"] += pm
        c["matched"] += tp
        c["decision: gold missed (FN)"] += gm - tp
        c["decision: extra kept (FP)"] += pm - tp
        c["decision: kind wrong on matched"] += tp - r.get("kindOk", 0)
        c["decision: certainty wrong on matched"] += tp - r.get("certOk", 0)
        c["decision: false memory (joke/hypothetical/quote kept)"] += r.get("falseMem", 0)
        gold_plans = r.get("plansGold", 0)
        c["plans gold"] += gold_plans
        c["decision: plan missed"] += gold_plans - r.get("plansTp", 0)
        c["generation: plan found, date wrong"] += r.get("plansTp", 0) - r.get("planDate", 0) if r.get("plansTp") else 0
        # A plan the gold has, whose words show up as a memorable observation instead.
        gold_whats = [p["what"].lower() for p in g["target"].get("plans", [])]
        for o in r.get("predicted", []):
            if o.get("certainty") in MEMORABLE and any(w.split()[0] in (o.get("text", "") + " " + o.get("value", "")).lower() for w in gold_whats if w):
                c["decision: plan written as observation"] += 1
        if r["task"] in ("joking", "hypothetical", "quoting") and pm:
            fp_cert["kept from a " + r["task"] + " example"] += pm
        if r["task"] == "noise" and pm:
            fp_cert["kept from a noise example"] += pm
        for ok in r.get("actionOk") or []:
            # The brain's action on each gold observation, gold answer vs model answer, per task.
            c["merge: action checks"] += 1
            if not ok:
                c["merge: action differs, " + r["task"]] += 1
        for d in r.get("dropped", []):
            c["guard dropped: " + d.split(" is ")[0].split(":")[0][:40]] += 1
    out = dict(c)
    out["where false positives come from"] = dict(fp_cert)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
