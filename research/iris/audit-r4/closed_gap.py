#!/usr/bin/env python3
"""How much of the open-vs-closed gap is real compounding, and how much is the strict metric compounding one naming
disagreement? (read-only; replays cached closed-loop generations; no model needed)

The strict closed loop (IrisBench, evaluate.py) links a model-written row to a teacher fact slot only when the add
strictly matches the gold op (entity + value). A row that states the right fact under other words stays unlinked, so
every later gold update / confirm / retract of that fact is re-derived as an `add` (or dropped) and the model is
penalised again in each later session. Store `key`s are evaluation provenance only: they are removed from the
prompt, so the model saw exactly the same input under any linking rule, and the cached generations stay valid.

Variants (same predictions, same guard, same per-session strict scoring; only the linking of rows to slots differs):
  strict     evaluate.py's rule (reproduces the reported closed-loop numbers)
  evidence   additionally, an unmatched add whose quote overlaps an unclaimed gold fact of the same session
             (same message, evid_overlap >= 0.5) is linked to that fact's slot. First-time naming errors still count
             once (in the session where they happen); they no longer turn later gold ops into `add`s.

Output: audit-r4/closed_gap.json

    cd research/iris && python3 audit-r4/closed_gap.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
from codeply_iris import contract, metrics  # noqa: E402
from codeply_iris.store import MemoryStore, derive_ops  # noqa: E402


def replay(label, rule):
    cache = {r["id"]: r for r in D.load_jsonl(D.RES / label / "preds-val-closed.jsonl")}
    recs = []
    for ep in D.EPS:
        store = MemoryStore()
        for s in ep["sessions"]:
            rows = store.view(s["now"][:10])
            gold = derive_ops(s, rows)
            key = f"{ep['id']}-s{s['sid']}"
            shown = [{k: v for k, v in m.items() if k != "key"} for m in rows]
            parsed = contract.parse(cache[key]["raw"])
            ops, rejected = contract.guard(parsed["ops"], s["messages"], shown, s["source"])
            rejected = [(o, f"schema_{why}") for o, why in parsed["dropped"]] + rejected
            c, keys = metrics.score_observe(ops, gold, rows, rejected)
            c["outputs"] += 1
            c["valid_outputs"] += bool(parsed["ok"])
            if rule == "evidence":
                claimed = {k for k in keys.values() if k is not None}
                gfacts = [g for g in gold if g["op"] in contract.PERSISTENT_OPS and g.get("key") is not None]
                for o in ops:
                    if o["op"] != "add" or keys.get(id(o)) is not None:
                        continue
                    best, bo = None, 0.0
                    for g in gfacts:
                        if g["key"] in claimed or g["src"] != o["src"]:
                            continue
                        ov = metrics.evid_overlap(o["evid"], g["evid"])
                        if ov >= 0.5 and ov > bo:
                            best, bo = g, ov
                    if best is not None:
                        keys[id(o)] = best["key"]
                        claimed.add(best["key"])
            rec = D.session_record(key, c, ops, rejected, gold, rows, s["messages"], ep["lang"], s["source"], s["sid"], ep["id"])
            rec["unlinked_rows"] = sum(1 for r in rows if r.get("key") is None)
            rec["rows"] = len(rows)
            recs.append(rec)
            for o in ops:
                store.apply({k: v for k, v in o.items() if not k.startswith("_")}, session=s["sid"], key=keys.get(id(o)))
    return recs


def summary(recs):
    t = D.row(D.agg(recs))
    out = {k: t[k] for k in ("extraction_precision", "extraction_recall", "extraction_f1", "false_memory_share",
                             "update_accuracy", "contradiction_resolution", "n_gold", "n_pred")}
    out["by_session_index_f1"] = {str(i): D.row(D.agg([r for r in recs if r["sid"] == i]))["extraction_f1"]
                                  for i in sorted({r["sid"] for r in recs})}
    out["gold_op_mix"] = dict(sorted(metrics.Counter(g["op"] for r in recs for g in r["gold"]).items()))
    later = [r for r in recs if r["sid"] > 1]
    out["mean_unlinked_rows_before_later_sessions"] = round(sum(r["unlinked_rows"] for r in later) / len(later), 2)
    out["mean_rows_before_later_sessions"] = round(sum(r["rows"] for r in later) / len(later), 2)
    return out


def main():
    res = {}
    for label in ("iris-1.7b-r2", "iris-1.7b-r3"):
        res[label] = {"open": {k: D.row(D.agg(D.open_records(label)))[k] for k in ("extraction_f1", "extraction_precision", "extraction_recall")},
                      "closed_strict": summary(replay(label, "strict")),
                      "closed_evidence_linked": summary(replay(label, "evidence"))}
        o, s, e = (res[label]["open"]["extraction_f1"], res[label]["closed_strict"]["extraction_f1"],
                   res[label]["closed_evidence_linked"]["extraction_f1"])
        res[label]["gap_open_minus_closed"] = {"strict": round(o - s, 3), "evidence_linked": round(o - e, 3),
                                               "share_of_gap_explained_by_linking": round((e - s) / (o - s), 2) if o != s else None}
        print(label, json.dumps(res[label], indent=1))
    (ROOT / "audit-r4" / "closed_gap.json").write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
