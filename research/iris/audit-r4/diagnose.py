#!/usr/bin/env python3
"""Error analysis of the Iris GPU run (r2 / r3, 0.6B and 1.7B) on the validation split. Read-only: it reads
results/gpu-r2/val/<label>/{details-val-open,preds-val-closed}.jsonl and data/built/val.jsonl + data/raw/val, and writes
only audit-r4/diagnosis.json (and prints tables). No model is loaded: the closed loop is replayed from the cached raw
generations exactly as evaluate.py ran it (same guard, same store, same gold derivation).

    cd research/iris && python3 audit-r4/diagnose.py
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from codeply_iris import build, contract, metrics  # noqa: E402
from codeply_iris.store import MemoryStore, derive_ops  # noqa: E402

LABELS = ["iris-1.7b-r2", "iris-1.7b-r3", "iris-0.6b-r2", "iris-0.6b-r3"]
RES = ROOT / "results" / "gpu-r2" / "val"


def load_jsonl(p):
    return [json.loads(l) for l in Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]


VAL = {e["id"]: e for e in load_jsonl(ROOT / "data" / "built" / "val.jsonl") if e["task"] == "observe"}
EPS, _ = build.load_raw(str(ROOT / "data" / "raw"), "val")
EP_META = {e["id"]: e for e in EPS}


def pairs_of(pred, gold, memories):
    """The one-to-one content matching of metrics.score_observe, returned explicitly."""
    universe = list({m["ent"] for m in memories} | {g["ent"] for g in gold if "ent" in g})
    pc = [o for o in pred if o["op"] in contract.PERSISTENT_OPS]
    gc = [o for o in gold if o["op"] in contract.PERSISTENT_OPS]
    cands = []
    for i, p in enumerate(pc):
        ent_p = metrics.resolve_entity(p["ent"], universe) or p["ent"]
        for j, g in enumerate(gc):
            s = metrics.content_score(p, g)
            if s:
                ent_ok = contract.norm(ent_p) == contract.norm(g["ent"])
                cands.append((s + (0.5 if ent_ok else 0) + (0.05 if p["src"] == g["src"] else 0), i, j, ent_ok))
    cands.sort(reverse=True)
    up, ug, out = set(), set(), []
    for _, i, j, ent_ok in cands:
        if i in up or j in ug:
            continue
        up.add(i)
        ug.add(j)
        out.append((pc[i], gc[j], ent_ok))
    strict_p = {id(p) for p, g, ok in out if ok}
    strict_g = {id(g) for p, g, ok in out if ok}
    return out, [p for p in pc if id(p) not in strict_p], [g for g in gc if id(g) not in strict_g]


def who(messages, src):
    return messages[src - 1]["who"] if 1 <= src <= len(messages) else "?"


def classify_false(p, gold, messages, memories):
    """Why an unmatched predicted content op counts as a false memory."""
    for g in gold:
        if g["op"] == "skip" and p["src"] == g["src"] and metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5:
            return "stored a labelled skip (" + g["why"] + ")"
    w = who(messages, p["src"])
    if w == "assistant":
        return "quote from an assistant message"
    if w != "user" and not str(w).startswith(("email from user", "note", "calendar", "screen")) and p["ent"] == "user":
        return "other speaker's statement attributed to the user"
    for g in gold:
        if g["op"] in contract.PERSISTENT_OPS and p["src"] == g["src"] and metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5:
            return "same statement as a gold fact, different value / slot / entity"
    return "statement the teacher did not label (extra or invented)"


def session_record(ex_id, counts, pred, rejected, gold, memories, messages, lang, source, sid, ep):
    return {"id": ex_id, "counts": counts, "pred": pred, "rejected": rejected, "gold": gold, "memories": memories,
            "messages": messages, "lang": lang, "source": source, "sid": sid, "episode": ep}


def open_records(label):
    recs = []
    for d in load_jsonl(RES / label / "details-val-open.jsonl"):
        ex = VAL[d["id"]]
        recs.append(session_record(d["id"], metrics.Counter(d["counts"]), d["pred"], d["rejected"], ex["gold"], ex["memories"],
                                   ex["messages"], ex["lang"], ex["source"], ex["sid"], ex["episode"]))
    return recs


def closed_records(label):
    cache = {r["id"]: r for r in load_jsonl(RES / label / "preds-val-closed.jsonl")}
    recs = []
    for ep in EPS:
        store = MemoryStore()
        for s in ep["sessions"]:
            today = s["now"][:10]
            rows = store.view(today)
            gold = derive_ops(s, rows)
            key = f"{ep['id']}-s{s['sid']}"
            shown = [{k: v for k, v in m.items() if k != "key"} for m in rows]
            parsed = contract.parse(cache[key]["raw"])
            ops, rejected = contract.guard(parsed["ops"], s["messages"], shown, s["source"])
            rejected = [(o, f"schema_{why}") for o, why in parsed["dropped"]] + rejected
            c, keys = metrics.score_observe(ops, gold, rows, rejected)
            c["outputs"] += 1
            c["valid_outputs"] += bool(parsed["ok"])
            rec = session_record(key, c, ops, rejected, gold, rows, s["messages"], ep["lang"], s["source"], s["sid"], ep["id"])
            rec["store_rows"] = len(rows)
            rec["store_false_rows"] = sum(1 for r in rows if r.get("key") is None)
            recs.append(rec)
            for o in ops:
                clean = {k: v for k, v in o.items() if not k.startswith("_")}
                store.apply(clean, session=s["sid"], key=keys.get(id(o)))
    return recs


def agg(recs):
    t = Counter()
    for r in recs:
        t.update(r["counts"])
    return t


def row(t):
    s = metrics.summarise(t)
    return {k: (round(s[k], 3) if s[k] == s[k] else None) for k in
            ("extraction_precision", "extraction_recall", "extraction_f1", "false_memory_share", "update_accuracy",
             "contradiction_resolution", "hard_negative_stored", "empty_session_accuracy", "duplicate_detection_recall",
             "output_validity")} | {"n_sessions": int(t["sessions"]), "n_gold": int(t["gold_content"]), "n_pred": int(t["pred_content"])}


def by(recs, f):
    g = defaultdict(list)
    for r in recs:
        g[f(r)].append(r)
    return {k: row(agg(v)) for k, v in sorted(g.items(), key=lambda kv: str(kv[0]))}


def op_table(t):
    def frac(a, b):
        return [int(a), int(b), round(a / b, 3) if b else None]
    return {
        "add (gold, matched, recall)": frac(t["gold_add_matched"], t["gold_add"]),
        "update: right op+ref (of gold updates)": frac(t["op_ok_update"], t["gold_update"]),
        "update: gold found at all": frac(t["gold_update_matched"], t["gold_update"]),
        "conflict: right op+ref": frac(t["op_ok_conflict"], t["gold_conflict"]),
        "confirm: found by ref": frac(t["confirm_tp"], t["confirm_gold"]),
        "confirm: answered with a duplicate add": [int(t["dup_created"]), int(t["confirm_gold"])],
        "confirm: answered with an update": [int(t["confirm_as_update"]), int(t["confirm_gold"])],
        "retract: found by ref": frac(t["retract_tp"], t["retract_gold"]),
        "retract: predicted (precision)": frac(t["retract_tp"], t["retract_pred"]),
        "skip: recorded as skip": frac(t["skip_tp"], t["skip_gold"]),
        "skip: stored instead (hard negative stored)": frac(t["skip_stored"], t["skip_gold"]),
        "skip: why correct (of recorded)": frac(t["skip_why_ok"], t["skip_tp"]),
        "skip ops predicted (precision of skip)": frac(t["skip_tp"], t["skip_pred"]),
    }


def skip_table(t):
    out = {}
    for why in ("joke", "hypothetical", "hearsay", "suggestion", "secret", "injection", "other"):
        n = int(t[f"skip_gold_{why}"])
        if n:
            out[why] = {"gold": n, "stored_as_memory": int(t[f"skip_stored_{why}"]), "stored_share": round(t[f"skip_stored_{why}"] / n, 3)}
    return out


def false_and_missed(recs):
    fm, miss, by_op = Counter(), Counter(), Counter()
    miss_detail = Counter()
    for r in recs:
        pairs, up, ug = pairs_of(r["pred"], r["gold"], r["memories"])
        for p in up:
            ent_p = p["ent"]
            dup = any(contract.norm(m["ent"]) == contract.norm(ent_p) and __import__("codeply_iris.store", fromlist=["x"]).same_value(m["val"], p["val"], m.get("when"), p.get("when")) for m in r["memories"])
            if dup:
                fm["(restatement of a stored memory: duplicate)"] += 1
                continue
            fm[classify_false(p, r["gold"], r["messages"], r["memories"])] += 1
            by_op[p["op"]] += 1
        for g in ug:
            miss["missed"] += 1
            miss_detail[f"op={g['op']}"] += 1
            miss_detail[f"basis={g.get('basis')}"] += 1
            miss_detail[f"kind={g.get('kind')}"] += 1
            miss_detail[f"conf={g.get('conf')}"] += 1
            w = who(r["messages"], g["src"])
            miss_detail["speaker=user" if w == "user" else "speaker=other"] += 1
        for p, g, ok in pairs:
            if ok:
                miss_detail[f"matched basis={g.get('basis')}"] += 1
                miss_detail[f"matched op={g['op']}"] += 1
                miss_detail[f"matched kind={g.get('kind')}"] += 1
                miss_detail[f"matched conf={g.get('conf')}"] += 1
                w = who(r["messages"], g["src"])
                miss_detail["matched speaker=user" if w == "user" else "matched speaker=other"] += 1
    return dict(fm), dict(by_op), dict(miss_detail), int(miss["missed"])


def main():
    out = {}
    for label in LABELS:
        o, c = open_records(label), closed_records(label)
        entry = {"open": row(agg(o)), "closed": row(agg(c))}
        for mode, recs in (("open", o), ("closed", c)):
            e = entry[mode + "_detail"] = {}
            e["by_operation"] = op_table(agg(recs))
            e["skip_by_kind"] = skip_table(agg(recs))
            e["by_language"] = by(recs, lambda r: r["lang"])
            e["by_source"] = by(recs, lambda r: r["source"])
            e["by_session_index"] = by(recs, lambda r: min(r["sid"], 4))
            fm, by_op, miss_detail, n_missed = false_and_missed(recs)
            e["false_memories_by_cause"] = fm
            e["false_memories_by_predicted_op"] = by_op
            e["gold_detail"] = miss_detail
            e["missed_gold"] = n_missed
            e["gold_op_mix"] = {k[5:]: int(v) for k, v in agg(recs).items() if k in ("gold_add", "gold_update", "gold_conflict")} | {
                "confirm": int(agg(recs)["confirm_gold"]), "retract": int(agg(recs)["retract_gold"]), "skip": int(agg(recs)["skip_gold"])}
        # closed-loop mechanisms
        sess1 = [r for r in c if r["sid"] == 1]
        later = [r for r in c if r["sid"] > 1]
        entry["closed_mechanisms"] = {
            "first_sessions_closed": row(agg(sess1)),
            "later_sessions_closed": row(agg(later)),
            "first_sessions_open": row(agg([r for r in o if r["sid"] == 1])),
            "later_sessions_open": row(agg([r for r in o if r["sid"] > 1])),
            "later_sessions_clean_store (no unlinked rows)": row(agg([r for r in later if r["store_false_rows"] == 0])),
            "later_sessions_polluted_store (>=1 unlinked row)": row(agg([r for r in later if r["store_false_rows"] > 0])),
            "mean_store_rows_before_session": round(sum(r["store_rows"] for r in later) / max(len(later), 1), 2),
            "mean_unlinked_rows_before_session": round(sum(r["store_false_rows"] for r in later) / max(len(later), 1), 2),
        }
        out[label] = entry
    # paired comparisons on the same resampled episodes (open and closed)
    pb = {}
    for mode in ("open", "closed"):
        per = {}
        for label in LABELS:
            recs = open_records(label) if mode == "open" else closed_records(label)
            d = defaultdict(Counter)
            for r in recs:
                d[r["episode"]].update(r["counts"])
            per[label] = d
        keys = ["extraction_f1", "extraction_precision", "extraction_recall", "false_memory_share", "update_accuracy"]
        for a, b in (("iris-1.7b-r3", "iris-1.7b-r2"), ("iris-1.7b-r3", "iris-0.6b-r3"), ("iris-1.7b-r2", "iris-0.6b-r2")):
            pb[f"{mode}: {a} - {b}"] = {k: [round(x, 3) for x in v] for k, v in metrics.paired_bootstrap(per[a], per[b], keys).items()}
    out["paired_bootstrap_95"] = pb
    (ROOT / "audit-r4" / "diagnosis.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote audit-r4/diagnosis.json")


if __name__ == "__main__":
    main()
