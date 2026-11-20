#!/usr/bin/env python3
"""R4 Phase A: stratified sample for the blind human review (R4-DATA-QUALITY-PROPOSAL §4). Read-only; no API; no test.

Writes, next to this script:
  packets-v1.json   what the reviewer sees: per item an opaque id, the conversation (date, source, language, the
                    memories stored before it, the messages) and ONE proposed operation, with the overlap flag.
                    No author (Opus / Sonnet), model, stratum, origin (teacher label vs model output) or correctness.
  key-v1.json       kept out of the review page: per item the stratum, origin, author, shard, example id, the
                    original operation exactly as labelled / generated, its strict-match status and all labelled
                    operations on the same message. Original labels are never edited; decisions live elsewhere.
Strata (target 280): false memories 80, updates 40, retractions 30, skip decisions 60, gold adds (control) 40,
Roman-Urdu / Urdu-script 30. 25 % of items (stratified) are flagged for a second reviewer.
Sources: data/built/{train,val}.jsonl (teacher labels; gold variant only) and committed validation outputs of the
seed-1 pilot Qwen3-4B, the pilot Qwen3-1.7B control and the historical r2 (open loop). The test split is not read.

    cd research/iris && python3 foundation-2026-11/next-phase/r4-phaseA/make_review_sample.py
"""
import hashlib, json, random, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "foundation-2026-11")); sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
import report_run as R  # noqa: E402
from codeply_iris import contract, metrics  # noqa: E402

SEED = 20261120
VERSION = "v1"
AUTHOR = {"tr01": "opus", "tr02": "opus", "tr03": "opus", "tr04": "sonnet", "tr05": "sonnet", "tr06": "sonnet",
          "va01": "opus", "va02": "sonnet"}
RUNS = {"qwen3-4b-pilot-s1": "results/foundation-2026-11/pilot-s1/qwen3-4b-2507",
        "qwen3-1.7b-pilot-control-s1": "results/foundation-2026-11/pilot-s1/qwen3-1.7b",
        "qwen3-1.7b-r2": "results/gpu-r2/val/iris-1.7b-r2"}
rng = random.Random(SEED)


def rows(split):
    out = []
    for l in (ROOT / f"data/built/{split}.jsonl").read_text(encoding="utf-8").splitlines():
        if l.strip():
            e = json.loads(l)
            if e["task"] == "observe" and e.get("variant", "gold") == "gold" and e["shard"] in AUTHOR:
                out.append(e)
    return out


EX = {e["id"]: e for e in rows("train") + rows("val")}
GOLD = [(e["id"], i, g) for e in EX.values() for i, g in enumerate(e["gold"])]


def same_msg(ex, op):
    return [g for g in ex["gold"] if g["src"] == op["src"]]


def overlaps_label(ex, op, kinds):
    return any(g["op"] in kinds and g["src"] == op["src"] and metrics.evid_overlap(op["evid"], g["evid"]) >= 0.5 for g in ex["gold"])


# model ops on validation, with strict status ----------------------------------------------------------------------
MODEL = []          # (run, example id, op, status)
for run, d in RUNS.items():
    for r in R.records(ROOT / d, "val", "open"):
        pairs, unp, _ = D.pairs_of(r["pred"], r["gold"], r["memories"])
        ok = {id(p) for p, g, m in pairs if m}
        for op in r["pred"]:
            if op["op"] in contract.PERSISTENT_OPS:
                st = "strict_correct" if id(op) in ok else "strict_incorrect"
            elif op["op"] == "skip":
                st = "skip_on_labelled_fact" if overlaps_label(EX[r["id"]], op, contract.PERSISTENT_OPS) else (
                    "skip_on_labelled_skip" if overlaps_label(EX[r["id"]], op, {"skip"}) else "skip_unlabelled")
            else:
                st = "other"
            MODEL.append((run, r["id"], {k: v for k, v in op.items() if not k.startswith("_")}, st))

picked, used = [], set()


def take(stratum, cands, n, origin_of):
    cands = [c for c in cands if (c[0], c[1], json.dumps(c[2], sort_keys=True)) not in used]
    rng.shuffle(cands)
    got = 0
    for c in cands:
        k = (c[0], c[1], json.dumps(c[2], sort_keys=True))
        if k in used:
            continue
        used.add(k)
        picked.append({"stratum": stratum, **origin_of(c)})
        got += 1
        if got == n:
            break
    return got


def from_model(c):
    run, ex_id, op, st = c
    return {"origin": "model_output", "model": run, "example_id": ex_id, "op": op, "strict_status": st}


def from_gold(c):
    ex_id, i, g = c
    return {"origin": "teacher_label", "model": None, "example_id": ex_id, "op": g, "strict_status": "teacher_label"}


def balanced(cands, n, key, take_fn, stratum, origin):
    groups = {}
    for c in cands:
        groups.setdefault(key(c), []).append(c)
    ks = sorted(groups)
    got = 0
    for i, k in enumerate(ks):
        quota = n // len(ks) + (1 if i < n % len(ks) else 0)
        got += take_fn(stratum, groups[k], quota, origin)
    return got


counts = {}
lang = lambda ex_id: EX[ex_id]["lang"]                                  # noqa: E731
author = lambda ex_id: AUTHOR[EX[ex_id]["shard"]]                        # noqa: E731
# S6 first, so Urdu items are not used up elsewhere: Roman-Urdu / Urdu-script / mixed, gold and model ops
urdu_g = [c for c in GOLD if lang(c[0]) in ("ur", "roman-ur", "mixed") and c[2]["op"] in ("add", "update", "retract", "skip")]
urdu_m = [c for c in MODEL if lang(c[1]) in ("ur", "roman-ur", "mixed") and c[2]["op"] in ("add", "update", "retract", "skip")]
counts["S6_urdu"] = take("S6_urdu", urdu_g, 15, from_gold) + take("S6_urdu", urdu_m, 15, from_model)
# S1 false memories: model content ops scored strictly incorrect; 4B and r2 equally, then authors balanced
fm = [c for c in MODEL if c[3] == "strict_incorrect" and c[2]["op"] in ("add", "conflict")]
counts["S1_false_memory"] = sum(balanced([c for c in fm if c[0] == run], 40, lambda c: author(c[1]), take, "S1_false_memory", from_model)
                                for run in ("qwen3-4b-pilot-s1", "qwen3-1.7b-r2"))
# S2 updates: teacher updates (val + train, both authors) and model updates scored wrong
SUB = {}
SUB["S2_teacher_update"] = balanced([c for c in GOLD if c[2]["op"] == "update"], 20, lambda c: author(c[0]), take, "S2_update", from_gold)
SUB["S2_model_update_wrong"] = take("S2_update", [c for c in MODEL if c[2]["op"] == "update" and c[3] == "strict_incorrect"], 20, from_model)
SUB["S2_topup_teacher_update"] = take("S2_update", [c for c in GOLD if c[2]["op"] == "update"], 40 - SUB["S2_teacher_update"] - SUB["S2_model_update_wrong"], from_gold)
counts["S2_update"] = SUB["S2_teacher_update"] + SUB["S2_model_update_wrong"] + SUB["S2_topup_teacher_update"]
# S3 retractions: teacher and model retracts
counts["S3_retract"] = balanced([c for c in GOLD if c[2]["op"] == "retract"], 15, lambda c: author(c[0]), take, "S3_retract", from_gold) + \
    take("S3_retract", [c for c in MODEL if c[2]["op"] == "retract"], 15, from_model)
# S4 skip decisions: model stored a labelled skip; model skipped a labelled fact; teacher skips Opus vs Sonnet (train)
stored_skip = [c for c in MODEL if c[2]["op"] in contract.PERSISTENT_OPS and overlaps_label(EX[c[1]], c[2], {"skip"})]
wrong_skip = [c for c in MODEL if c[3] == "skip_on_labelled_fact"]
tr_skip = [c for c in GOLD if c[2]["op"] == "skip" and EX[c[0]]["split"] == "train"]
SUB["S4_model_stored_labelled_skip"] = take("S4_skip", stored_skip, 15, from_model)
SUB["S4_model_skipped_labelled_fact"] = take("S4_skip", wrong_skip, 15, from_model)
SUB["S4_teacher_skip_train"] = balanced(tr_skip, 30, lambda c: author(c[0]), take, "S4_skip", from_gold)
short = 60 - SUB["S4_model_stored_labelled_skip"] - SUB["S4_model_skipped_labelled_fact"] - SUB["S4_teacher_skip_train"]
SUB["S4_topup_teacher_skip_val"] = balanced([c for c in GOLD if c[2]["op"] == "skip" and EX[c[0]]["split"] == "val"], short, lambda c: author(c[0]), take, "S4_skip", from_gold) if short > 0 else 0
counts["S4_skip"] = sum(v for k, v in SUB.items() if k.startswith("S4_"))
# S5 control: random teacher adds, authors balanced (train + val)
counts["S5_gold_add_control"] = balanced([c for c in GOLD if c[2]["op"] == "add"], 40, lambda c: author(c[0]), take, "S5_gold_add_control", from_gold)

# packets and key ---------------------------------------------------------------------------------------------------
rng.shuffle(picked)
SHOW = ("op", "ent", "type", "attr", "val", "kind", "when", "until", "keep", "ref", "rel", "src", "evid", "why")
packets, key = [], {}
strata = sorted({p["stratum"] for p in picked})
overlap = set()
for s in strata:
    ids = [i for i, p in enumerate(picked) if p["stratum"] == s]
    overlap |= set(ids[: max(1, round(0.25 * len(ids)))])
for i, p in enumerate(picked):
    ex = EX[p["example_id"]]
    item = hashlib.sha256(f"{SEED}-{i}-{p['example_id']}".encode()).hexdigest()[:10]
    mems = [{k: m.get(k) for k in ("id", "ent", "attr", "val", "kind", "when", "until") if m.get(k) is not None} for m in ex["memories"]]
    op = {k: p["op"][k] for k in SHOW if k in p["op"]}
    if op.get("ref"):
        tgt = next((m for m in ex["memories"] if m["id"] == op["ref"]), None)
        op["ref_memory"] = {k: tgt.get(k) for k in ("ent", "attr", "val")} if tgt else None
    packets.append({"item": item, "overlap": i in overlap, "now": ex["now"], "source": ex["source"], "lang": ex["lang"],
                    "memories": mems, "messages": ex["messages"], "proposed": op})
    key[item] = {"stratum": p["stratum"], "origin": p["origin"], "model": p["model"], "example_id": p["example_id"],
                 "split": ex["split"], "shard": ex["shard"], "author": AUTHOR[ex["shard"]], "lang": ex["lang"],
                 "strict_status": p["strict_status"], "original_op": p["op"], "labelled_ops_same_message": same_msg(ex, p["op"])}
blob = json.dumps(packets, ensure_ascii=False, sort_keys=True).encode()
meta = {"schema": "r4-phaseA-packets/1", "version": VERSION, "seed": SEED, "items": len(packets),
        "overlap_items": len(overlap), "sha256": hashlib.sha256(blob).hexdigest(), "test_split_read": False}
SOURCES = {"teacher": "data/built/{train,val}.jsonl (gold variant)", "model_outputs": RUNS}
(HERE / f"packets-{VERSION}.json").write_text(json.dumps({"meta": meta, "items": packets}, ensure_ascii=False, indent=0) + "\n")
(HERE / f"key-{VERSION}.json").write_text(json.dumps({"meta": {**meta, "schema": "r4-phaseA-key/1", "sources": SOURCES}, "key": key}, ensure_ascii=False, indent=1) + "\n")
summary = {"counts": counts, "sub_sources": SUB, "available": {"model_update_wrong": sum(1 for c in MODEL if c[2]["op"] == "update" and c[3] == "strict_incorrect"),
           "model_stored_labelled_skip": len(stored_skip), "model_skipped_labelled_fact": len(wrong_skip)}, "total": len(packets), "overlap": len(overlap),
           "by_origin": {o: sum(1 for v in key.values() if v["origin"] == o) for o in ("teacher_label", "model_output")},
           "by_author": {a: sum(1 for v in key.values() if v["author"] == a) for a in ("opus", "sonnet")},
           "by_lang": {l: sum(1 for v in key.values() if v["lang"] == l) for l in ("en", "roman-ur", "ur", "mixed")},
           "by_split": {s: sum(1 for v in key.values() if v["split"] == s) for s in ("train", "val")},
           "packets_sha256": meta["sha256"]}
(HERE / f"sample-summary-{VERSION}.json").write_text(json.dumps(summary, indent=1) + "\n")
print(json.dumps(summary, indent=1))
