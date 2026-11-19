#!/usr/bin/env python3
"""Foundation-oriented failure analysis of every committed Iris validation run. Read-only, CPU-only, no model.

Question: which Iris failures would a different *base model* change, and which come from the data, the prompt,
the output contract or the evaluation pipeline? The main lever is a controlled comparison already in the repo:
Qwen3-0.6B and Qwen3-1.7B were fine-tuned with the same data, recipe, seed and evaluation (Kaggle run I16), so a
failure that shrinks from 0.6B to 1.7B is capacity-sensitive (a better foundation can help), and a failure that
does not move is bound to something both models share (labels, data, contract, metric).

Inputs (all committed): results/gpu-r2/val/<run>/{details-val-open,preds-val-closed}.jsonl, data/built/val.jsonl,
data/raw/val, results/val/zeroshot-qwen3-0.6b (old 12-episode val; analysed separately, never compared with the
24-episode val numbers). Reuses audit-r4/diagnose.py (same matching, same closed-loop replay as evaluate.py).

    cd research/iris && python3 foundation-2026-11/failure_analysis.py   # writes foundation-2026-11/failure_analysis.json
"""
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
from codeply_iris import contract, metrics  # noqa: E402
from codeply_iris.contract import squash  # noqa: E402
from codeply_iris.store import same_value  # noqa: E402

RUNS = ["iris-0.6b-r2", "iris-1.7b-r2", "iris-0.6b-r3", "iris-1.7b-r3"]
ZS_COMMIT = "60129998"   # commit that added the zero-shot result and the val build it was run on
PAIRS = [("iris-0.6b-r2", "iris-1.7b-r2"), ("iris-0.6b-r3", "iris-1.7b-r3")]


def r3(x):
    return None if x is None or x != x else round(x, 3)


def per100(n, sessions):
    return round(100.0 * n / sessions, 1) if sessions else None


# ---------------------------------------------------------------- 1. false memories and misses by category
def taxonomy(recs):
    sessions = len(recs)
    fm, missed, pred_n, gold_n = Counter(), Counter(), 0, 0
    for r in recs:
        pairs, up, ug = D.pairs_of(r["pred"], r["gold"], r["memories"])
        pred_n += sum(1 for o in r["pred"] if o["op"] in contract.PERSISTENT_OPS)
        gold_n += sum(1 for o in r["gold"] if o["op"] in contract.PERSISTENT_OPS)
        for p in up:
            dup = any(contract.norm(m["ent"]) == contract.norm(p["ent"]) and same_value(m["val"], p["val"], m.get("when"), p.get("when"))
                      for m in r["memories"])
            if dup:
                fm["restatement of a stored memory (duplicate, not counted as false)"] += 1
                continue
            cat = D.classify_false(p, r["gold"], r["messages"], r["memories"])
            if cat.startswith("stored a labelled skip"):
                cat = "stored a labelled skip (joke / hypothetical / hearsay / suggestion / secret / injection)"
            if cat == "same statement as a gold fact, different value / slot / entity":
                # split the near misses: which part disagrees with the best gold op on the same statement
                g = max((g for g in r["gold"] if g["op"] in contract.PERSISTENT_OPS and g["src"] == p["src"]
                         and metrics.evid_overlap(p["evid"], g["evid"]) >= 0.5),
                        key=lambda g: metrics.value_sim(p.get("val", ""), g.get("val", "")))
                ent_ok = contract.norm(metrics.resolve_entity(p["ent"], [g["ent"]]) or p["ent"]) == contract.norm(g["ent"])
                val_ok = metrics.content_score(p, g) > 0
                if ent_ok and not val_ok:
                    gw, pw = g.get("when"), p.get("when")
                    sub = "same entity, different value: date disagrees" if (gw and pw and gw[:10] != pw[:10]) else \
                          "same entity, different value: date missing" if (gw and not pw) else "same entity, different value / granularity"
                elif val_ok and not ent_ok:
                    sub = "same value, different entity (entity resolution)"
                else:
                    sub = "entity and value both differ"
                cat = "near miss: " + sub
            fm[cat] += 1
        for g in ug:
            touched = any(o["src"] == g["src"] and metrics.evid_overlap(o["evid"], g["evid"]) >= 0.5 for o in r["pred"])
            missed["missed, statement touched (near miss)" if touched else "missed, statement untouched"] += 1
    false_total = sum(v for k, v in fm.items() if not k.startswith("restatement"))
    return {"sessions": sessions, "pred_content": pred_n, "gold_content": gold_n, "false_memories": false_total,
            "false_per_100_sessions": per100(false_total, sessions),
            "false_by_category": {k: {"n": v, "per_100_sessions": per100(v, sessions),
                                      "share_of_false": r3(v / false_total) if false_total and not k.startswith("restatement") else None}
                                  for k, v in fm.most_common()},
            "missed_by_category": {k: {"n": v, "share_of_gold": r3(v / gold_n)} for k, v in missed.most_common()}}


# ---------------------------------------------------------------- 2. precision by the model's own confidence / basis
def calibration(recs):
    out = defaultdict(lambda: [0, 0])
    for r in recs:
        pairs, up, ug = D.pairs_of(r["pred"], r["gold"], r["memories"])
        strict = {id(p) for p, g, ok in pairs if ok}
        for p in r["pred"]:
            if p["op"] not in contract.PERSISTENT_OPS:
                continue
            for key in (f"conf={p.get('conf')}", f"basis={p.get('basis')}", f"op={p['op']}", f"kind={p.get('kind')}"):
                out[key][0] += id(p) in strict
                out[key][1] += 1
    return {k: {"correct": a, "predicted": b, "precision": r3(a / b) if b else None} for k, (a, b) in sorted(out.items())}


# ---------------------------------------------------------------- 3. gold items: who finds them (open loop, same gold for all runs)
def item_overlap(open_recs):
    found = defaultdict(set)
    meta = {}
    for run, recs in open_recs.items():
        for r in recs:
            pairs, _, _ = D.pairs_of(r["pred"], r["gold"], r["memories"])
            for i, g in enumerate(o for o in r["gold"] if o["op"] in contract.PERSISTENT_OPS):
                key = (r["id"], i)
                meta[key] = (g, r)
            for p, g, ok in pairs:
                if ok:
                    idx = [o for o in r["gold"] if o["op"] in contract.PERSISTENT_OPS].index(g)
                    found[(r["id"], idx)].add(run)
    groups = Counter()
    attrs = defaultdict(Counter)
    for key, (g, r) in meta.items():
        runs = found.get(key, set())
        has06 = any("0.6b" in x for x in runs)
        has17 = any("1.7b" in x for x in runs)
        grp = "found by both sizes" if has06 and has17 else "only 1.7B finds it" if has17 else "only 0.6B finds it" if has06 else "no run finds it"
        groups[grp] += 1
        w = D.who(r["messages"], g["src"])
        for a in (f"basis={g.get('basis')}", f"kind={g.get('kind')}", f"op={g['op']}", f"lang={r['lang']}",
                  f"label_source={'Opus (va01)' if r['episode'].startswith('va01') else 'Sonnet (va02)'}",
                  "speaker=user" if w == "user" else "speaker=other", f"source={r['source']}"):
            attrs[grp][a] += 1
    total = sum(groups.values())
    return {"n_gold_items": total,
            "groups": {k: {"n": v, "share": r3(v / total)} for k, v in groups.most_common()},
            "attributes_by_group": {k: dict(sorted(v.items())) for k, v in attrs.items()}}


# ---------------------------------------------------------------- 4. slices that matter for foundation choice
def length_bin(r):
    words = sum(len(m["text"].split()) for m in r["messages"])
    return "words<150" if words < 150 else "words150-399" if words < 400 else "words>=400"


def store_bin(r):
    n = len(r["memories"])
    return "memories<6" if n < 6 else "memories6-11" if n < 12 else "memories>=12"


def slices(recs):
    return {"language": D.by(recs, lambda r: r["lang"]),
            "label_source": D.by(recs, lambda r: "Opus (va01)" if r["episode"].startswith("va01") else "Sonnet (va02)"),
            "input_words": D.by(recs, length_bin),
            "store_size": D.by(recs, store_bin),
            "source": D.by(recs, lambda r: r["source"]),
            "session_index": D.by(recs, lambda r: r["sid"])}


# ---------------------------------------------------------------- 5. temporal errors on matched ops
def temporal(recs):
    c = Counter()
    for r in recs:
        pairs, _, _ = D.pairs_of(r["pred"], r["gold"], r["memories"])
        for p, g, ok in pairs:
            if not g.get("when"):
                continue
            pw, gw = p.get("when"), g["when"]
            if not pw:
                c["gold has a date, prediction has none"] += 1
            elif pw[:10] == gw[:10]:
                c["date correct"] += 1
            elif pw[:4] != gw[:4]:
                c["wrong year"] += 1
            elif len(pw) >= 10 and len(gw) >= 10:
                import datetime as dt
                try:
                    d = abs((dt.date.fromisoformat(pw[:10]) - dt.date.fromisoformat(gw[:10])).days)
                    c["off by 1-2 days" if d <= 2 else "off by exactly 7 days" if d == 7 else "off by other"] += 1
                except ValueError:
                    c["unparseable date"] += 1
            else:
                c["different precision (month vs day)"] += 1
    n = sum(c.values())
    return {"n_matched_with_gold_date": n, **{k: {"n": v, "share": r3(v / n)} for k, v in c.most_common()}}


# ---------------------------------------------------------------- 6. guard rejections (evidence quotes, schema)
def rejections(recs):
    c = Counter()
    emitted = 0
    for r in recs:
        emitted += len(r["pred"]) + len(r["rejected"])
        for o, why in r["rejected"]:
            c[why] += 1
    return {"ops_emitted": emitted, **{k: {"n": v, "share_of_emitted": r3(v / emitted)} for k, v in c.most_common()}}


# ---------------------------------------------------------------- 7. zero-shot Qwen3-0.6B (old val): what failed
def zeroshot():
    base = ROOT / "results" / "val" / "zeroshot-qwen3-0.6b"
    res = json.loads((base / "result-val-open.json").read_text())
    preds = {r["id"]: r for r in D.load_jsonl(base / "preds-val-open.jsonl")}
    # the run used the val build of commit 60129998 (va01 only, sha256 cf92649d...); read it from git, unchanged
    import subprocess
    old = subprocess.run(["git", "show", f"{ZS_COMMIT}:research/iris/data/built/val.jsonl"], cwd=ROOT, capture_output=True,
                         text=True, check=True).stdout
    built = {e["id"]: e for e in (json.loads(l) for l in old.splitlines() if l.strip())}
    reasons, prefixed, c_orig, c_strip = Counter(), Counter(), Counter(), Counter()
    missing = 0
    for key, p in preds.items():
        ex = built.get(key)
        if ex is None or ex["task"] != "observe":
            missing += ex is None
            continue
        parsed = contract.parse(p["raw"])
        ops, rej = contract.guard(parsed["ops"], ex["messages"], ex["memories"], ex["source"])
        for o, why in [(o, f"schema_{w}") for o, w in parsed["dropped"]] + rej:
            reasons[why] += 1
            if why == "ungrounded_evidence" and 1 <= o["src"] <= len(ex["messages"]):
                m = ex["messages"][o["src"] - 1]
                ev = squash(o["evid"])
                if ev.lower().startswith(squash(m["who"]).lower() + ":"):
                    prefixed["quote starts with the speaker label"] += 1
                elif ev.startswith("[") or ev[:4].strip("[]0123456789 ") == "":
                    prefixed["quote starts with the message number"] += 1
                else:
                    prefixed["quote paraphrased or from another message"] += 1
        c, _ = metrics.score_observe(ops, ex["gold"], ex["memories"], rej)
        c_orig.update(c)
        # diagnostic only: strip a leading "speaker: " from every quote, then re-guard and re-score
        fixed = []
        for o in parsed["ops"]:
            o2 = dict(o)
            if 1 <= o2["src"] <= len(ex["messages"]):
                pre = squash(ex["messages"][o2["src"] - 1]["who"]) + ":"
                ev = squash(o2["evid"])
                if ev.lower().startswith(pre.lower()):
                    o2["evid"] = ev[len(pre):].strip()
            fixed.append(o2)
        ops2, rej2 = contract.guard(fixed, ex["messages"], ex["memories"], ex["source"])
        c2, _ = metrics.score_observe(ops2, ex["gold"], ex["memories"], rej2)
        c_strip.update(c2)
    s1, s2 = metrics.summarise(c_orig), metrics.summarise(c_strip)
    keep = ("extraction_f1", "extraction_precision", "extraction_recall", "false_memory_share")
    return {"artifact": "results/val/zeroshot-qwen3-0.6b", "model": res["model"], "constrained": res["constrained"],
            "val_version": f"{res['episodes']} episodes / {res['metrics']['n_sessions']} sessions (va01 only, pre-I14); "
                           "NOT the 24-episode val used for r2/r3",
            "observe_sessions_rescored_here": int(c_orig["sessions"]),
            "reported": {k: r3(res["metrics"][k]) for k in keep + ("output_validity", "ungrounded_evidence_rate", "guard_rejection_rate")},
            "latency_ms": res["latency_ms"],
            "rejection_reasons": dict(reasons.most_common()),
            "ungrounded_quote_patterns": dict(prefixed),
            "rescored_as_committed": {k: r3(s1[k]) for k in keep},
            "diagnostic_speaker_prefix_stripped": {k: r3(s2[k]) for k in keep},
            "scored_against": f"git {ZS_COMMIT}:research/iris/data/built/val.jsonl", "cached_ids_not_found": missing,
            "note": "reported false_memory_share predates the I11 metric fix (misattributed ops counted twice); "
                    "rescored_as_committed uses the current metric code"}


def main():
    open_recs = {run: D.open_records(run) for run in RUNS}
    closed_recs = {run: D.closed_records(run) for run in RUNS}
    out = {"inputs": {"runs": RUNS, "val": "data/built/val.jsonl (24 episodes, 120 observe sessions)"}}
    for run in RUNS:
        o, c = open_recs[run], closed_recs[run]
        out[run] = {
            "open": {"summary": D.row(D.agg(o)), "by_operation": D.op_table(D.agg(o)), "skips": D.skip_table(D.agg(o)),
                     "taxonomy": taxonomy(o), "calibration": calibration(o), "temporal": temporal(o),
                     "rejections": rejections(o), "slices": slices(o)},
            "closed": {"summary": D.row(D.agg(c)), "by_operation": D.op_table(D.agg(c)), "taxonomy": taxonomy(c),
                       "calibration": calibration(c), "rejections": rejections(c),
                       "slices": {"session_index": D.by(c, lambda r: r["sid"]), "language": D.by(c, lambda r: r["lang"])}},
        }
    # scale sensitivity: 1.7B / 0.6B for every false-memory and miss category, same recipe
    scale = {}
    for small, big in PAIRS:
        for mode in ("open", "closed"):
            a, b = out[small][mode]["taxonomy"], out[big][mode]["taxonomy"]
            rows = {}
            for k in sorted(set(a["false_by_category"]) | set(b["false_by_category"])):
                x = a["false_by_category"].get(k, {"n": 0})["n"]
                y = b["false_by_category"].get(k, {"n": 0})["n"]
                rows["false: " + k] = {"0.6B": x, "1.7B": y, "ratio_1.7B_over_0.6B": r3(y / x) if x else None}
            for k in sorted(set(a["missed_by_category"]) | set(b["missed_by_category"])):
                x = a["missed_by_category"].get(k, {"n": 0})["n"]
                y = b["missed_by_category"].get(k, {"n": 0})["n"]
                rows["missed: " + k] = {"0.6B": x, "1.7B": y, "ratio_1.7B_over_0.6B": r3(y / x) if x else None}
            scale[f"{small} vs {big} ({mode})"] = rows
    out["scale_sensitivity"] = scale
    out["gold_item_overlap_open"] = item_overlap(open_recs)
    out["zeroshot_qwen3_0.6b_old_val"] = zeroshot()
    random.seed(0)
    (HERE / "failure_analysis.json").write_text(json.dumps(out, indent=1, ensure_ascii=False, default=str) + "\n")
    # console summary
    for run in RUNS:
        for mode in ("open", "closed"):
            s = out[run][mode]["summary"]
            t = out[run][mode]["taxonomy"]
            print(f"{run:14s} {mode:6s} P {s['extraction_precision']} R {s['extraction_recall']} F1 {s['extraction_f1']} "
                  f"FMS {s['false_memory_share']} false/100s {t['false_per_100_sessions']}")


if __name__ == "__main__":
    main()
