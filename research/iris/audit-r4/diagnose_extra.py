#!/usr/bin/env python3
"""Second part of the r2 / r3 error analysis (read-only; uses diagnose.py's replay of the cached generations).

Writes audit-r4/diagnosis_extra.json:
  statement_level   same-quoted-statement detection (diagnostic only; the strict IrisBench match stays the primary metric)
  near_miss_split   statements the model found but did not strictly match: wrong entity / different value / both / not touched
  precision_by      precision of predicted content ops by the model's own conf / basis / kind / op fields
  value_support     does a lexical "value words occur in the message" guard help? (it does not)
  schema_drops      why operations are dropped by the schema check, per checkpoint

    cd research/iris && python3 audit-r4/diagnose_extra.py
"""
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
from codeply_iris import contract, metrics  # noqa: E402
from codeply_iris.store import value_sim  # noqa: E402

STOP = set("the a an of to in on at for and or is are was were be been it this that with by from as user".split())


def statement_level(recs):
    c = Counter()
    for r in recs:
        gc = [g for g in r["gold"] if g["op"] in contract.PERSISTENT_OPS]
        pc = [p for p in r["pred"] if p["op"] in contract.PERSISTENT_OPS]
        cands = sorted(((metrics.evid_overlap(p["evid"], g["evid"]), i, j) for i, p in enumerate(pc) for j, g in enumerate(gc)
                        if p["src"] == g["src"] and metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5), reverse=True)
        up, ug = set(), set()
        for _, i, j in cands:
            if i not in up and j not in ug:
                up.add(i)
                ug.add(j)
        strict = {id(g) for p, g, ok in D.pairs_of(r["pred"], r["gold"], r["memories"])[0] if ok}
        c["gold"] += len(gc)
        c["pred"] += len(pc)
        c["stmt_tp"] += len(up)
        c["strict_tp"] += len(strict)
        c["hit_not_strict"] += len([j for j in ug if id(gc[j]) not in strict])
        c["pred_off_gold_statement"] += len(pc) - len(up)
    P, R = c["stmt_tp"] / c["pred"], c["stmt_tp"] / c["gold"]
    sP, sR = c["strict_tp"] / c["pred"], c["strict_tp"] / c["gold"]
    return {"statement_precision": round(P, 3), "statement_recall": round(R, 3), "statement_f1": round(2 * P * R / (P + R), 3),
            "strict_f1": round(2 * sP * sR / (sP + sR), 3), "gold_ops": c["gold"], "pred_ops": c["pred"],
            "gold_statements_touched": c["stmt_tp"], "touched_but_not_strict": c["hit_not_strict"],
            "pred_ops_on_no_gold_statement": c["pred_off_gold_statement"]}


def near_miss_split(recs):
    c = Counter()
    for r in recs:
        gc = [g for g in r["gold"] if g["op"] in contract.PERSISTENT_OPS]
        pc = [p for p in r["pred"] if p["op"] in contract.PERSISTENT_OPS]
        strict = {id(g) for p, g, ok in D.pairs_of(r["pred"], r["gold"], r["memories"])[0] if ok}
        universe = list({m["ent"] for m in r["memories"]} | {g["ent"] for g in r["gold"] if "ent" in g})
        for g in gc:
            if id(g) in strict:
                c["strict match"] += 1
                continue
            cand = [p for p in pc if p["src"] == g["src"] and metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5]
            if not cand:
                c["gold statement not touched"] += 1
                continue
            p = max(cand, key=lambda p: value_sim(p["val"], g["val"]))
            ent_ok = contract.norm(metrics.resolve_entity(p["ent"], universe) or p["ent"]) == contract.norm(g["ent"])
            val_ok = value_sim(p["val"], g["val"]) >= 0.5
            c["value ok, wrong entity" if val_ok and not ent_ok else "entity ok, value differs" if ent_ok else "entity and value differ"] += 1
    return dict(c)


def precision_by(recs):
    rows = []
    for r in recs:
        tp = {id(p) for p, g, ok in D.pairs_of(r["pred"], r["gold"], r["memories"])[0] if ok}
        rows += [(id(p) in tp, p) for p in r["pred"] if p["op"] in contract.PERSISTENT_OPS]
    out = {"n_pred": len(rows), "precision": round(sum(t for t, _ in rows) / len(rows), 3)}
    for f in ("conf", "basis", "kind", "op"):
        g = defaultdict(lambda: [0, 0])
        for t, p in rows:
            g[p.get(f)][0] += t
            g[p.get(f)][1] += 1
        out[f] = {k: {"precision": round(a / b, 2), "n": b} for k, (a, b) in sorted(g.items(), key=lambda kv: -kv[1][1])}
    return out


def value_support(recs):
    def sup(p, msgs):
        text = set(contract.norm(msgs[p["src"] - 1]["text"]).split()) if 1 <= p["src"] <= len(msgs) else set()
        vt = [t for t in contract.norm(p["val"]).split() if t not in STOP and len(t) > 1]
        return sum(t in text for t in vt) / len(vt) if vt else 1.0
    rows, gold_n = [], 0
    for r in recs:
        tp = {id(p) for p, g, ok in D.pairs_of(r["pred"], r["gold"], r["memories"])[0] if ok}
        gold_n += sum(1 for g in r["gold"] if g["op"] in contract.PERSISTENT_OPS)
        rows += [(id(p) in tp, sup(p, r["messages"])) for p in r["pred"] if p["op"] in contract.PERSISTENT_OPS]
    sweep = {}
    for th in (0, 0.3, 0.5, 0.7):
        kept = [t for t, s in rows if s >= th]
        P, R = sum(kept) / len(kept), sum(kept) / gold_n
        sweep[str(th)] = {"kept": len(kept), "precision": round(P, 3), "recall": round(R, 3), "f1": round(2 * P * R / (P + R), 3)}
    return {"sweep": sweep, "mean_support_true": round(statistics.mean(s for t, s in rows if t), 2),
            "mean_support_false": round(statistics.mean(s for t, s in rows if not t), 2)}


def schema_drops(label):
    c, n = Counter(), 0
    for mode in ("open", "closed"):
        for l in (D.RES / label / f"preds-val-{mode}.jsonl").read_text(encoding="utf-8").splitlines():
            p = json.loads(l)
            if "-q" in p["id"]:
                continue
            n += 1
            for _, why in contract.parse(p["raw"])["dropped"]:
                c[why[:40]] += 1
    return {"observe_outputs": n, "ops_dropped": dict(c.most_common())}


def main():
    out = {}
    for label in ("iris-1.7b-r2", "iris-1.7b-r3", "iris-0.6b-r3"):
        out[label] = {}
        for mode, recs in (("open", D.open_records(label)), ("closed", D.closed_records(label))):
            out[label][mode] = {"statement_level": statement_level(recs), "near_miss_split": near_miss_split(recs),
                                "precision_by": precision_by(recs), "value_support": value_support(recs)}
        out[label]["schema_drops"] = schema_drops(label)
    (ROOT / "audit-r4" / "diagnosis_extra.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print("wrote audit-r4/diagnosis_extra.json")


if __name__ == "__main__":
    main()
