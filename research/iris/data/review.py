#!/usr/bin/env python3
"""Blind review of teacher labels (independent verification; the teacher is not assumed correct).

    python review.py packets --split test --n 60 --seed 7 --out review/test-r1        # text only, no labels
    # an independent annotator fills <out>/answers.jsonl following review/INSTRUCTIONS.md
    python review.py compare --dir review/test-r1                                     # agreement + disagreements

A packet is one session exactly as the model sees it (time, source, the gold store before the session, the
messages). The annotator writes operations in the iris.ops/1 format without seeing the teacher's labels. The
comparison scores the annotator's operations against the teacher's with the IrisBench scorer:
  label agreement F1      content facts both found (entity + value)
  teacher-only facts      labelled by the teacher, not found by the annotator  -> possibly unsupported labels
  annotator-only facts    found by the annotator, not labelled                  -> possibly unlabelled extras
Acceptance rule (pre-registered in DATASET.md before the first review): agreement F1 >= 0.80 and every
disagreement in the sample adjudicated; a split whose adjudicated error rate (wrong or missing teacher label,
per session) exceeds 10 % is corrected and re-reviewed, not used as is.
"""
import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from codeply_iris import contract, metrics  # noqa: E402


def packets(a):
    ex = [json.loads(l) for l in (HERE / "built" / f"{a.split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    ex = [e for e in ex if e["task"] == "observe" and e["variant"] == "gold" and not str(e.get("shard", "")).startswith("syn")
          and (not a.shards or e["shard"] in a.shards)]
    rng = random.Random(a.seed)
    rng.shuffle(ex)
    ex = ex[:a.n]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "packets.jsonl").open("w", encoding="utf-8") as f, (out / "key.jsonl").open("w", encoding="utf-8") as k:
        for i, e in enumerate(ex, 1):
            pid = f"p{i:03d}"
            f.write(json.dumps({"id": pid, "prompt": e["prompt"]}, ensure_ascii=False) + "\n")
            k.write(json.dumps({"id": pid, "example": e["id"], "gold": e["gold"], "memories": e["memories"], "messages": e["messages"],
                                "source": e["source"]}, ensure_ascii=False) + "\n")
    print(f"wrote {len(ex)} packets to {out}/packets.jsonl (labels are in key.jsonl: do not show it to the annotator)")


def compare(a):
    d = Path(a.dir)
    key = {r["id"]: r for r in map(json.loads, (d / "key.jsonl").read_text(encoding="utf-8").splitlines())}
    ans = {r["id"]: r for r in map(json.loads, (d / "answers.jsonl").read_text(encoding="utf-8").splitlines()) if r}
    tot, lines, flagged = Counter(), [], 0
    for pid, k in sorted(key.items()):
        if pid not in ans:
            continue
        parsed = contract.parse(json.dumps({"ops": ans[pid].get("ops", [])}))
        ops, rej = contract.guard(parsed["ops"], k["messages"], k["memories"], k["source"])
        c, _ = metrics.score_observe(ops, k["gold"], k["memories"], rej)
        tot.update(c)
        tot["reviewed"] += 1
        gold_c = [g for g in k["gold"] if g["op"] in contract.PERSISTENT_OPS]
        pred_c = [o for o in ops if o["op"] in contract.PERSISTENT_OPS]
        miss, extra = c["gold_content"] - c["tp"], c["pred_content"] - c["tp"] - c["dup_restated"]
        ref_diff = c["confirm_gold"] != c["confirm_tp"] or c["retract_gold"] != c["retract_tp"]
        if miss or extra or ref_diff or parsed["dropped"] or rej:
            flagged += 1
            lines.append({"id": pid, "example": k["example"], "teacher_only": miss, "annotator_only": extra,
                          "teacher": [{x: g.get(x) for x in ("op", "ref", "ent", "attr", "val", "when", "evid")} for g in k["gold"] if g["op"] != "skip"],
                          "annotator": [{x: o.get(x) for x in ("op", "ref", "ent", "attr", "val", "when", "evid")} for o in ops if o["op"] != "skip"],
                          "invalid": [str(r) for _, r in parsed["dropped"]] + [r for _, r in rej]})
    s = metrics.summarise(tot)
    rep = {"reviewed": tot["reviewed"], "agreement_f1": s["extraction_f1"], "teacher_facts_found_by_annotator": s["extraction_recall"],
           "annotator_facts_labelled_by_teacher": s["extraction_precision"], "teacher_content_facts": tot["gold_content"],
           "annotator_content_facts": tot["pred_content"], "sessions_with_any_disagreement": flagged,
           "op_agreement_update": s["update_accuracy_when_found"], "date_agreement": s["temporal_date_accuracy"],
           "keep_agreement": s["persistence_accuracy"], "kind_agreement": s["kind_accuracy"], "sens_agreement": s["sensitivity_accuracy"],
           "confirm_agreement_recall": s["duplicate_detection_recall"], "retract_agreement_f1": s["retraction_f1"],
           "skip_agreement_recall": s["skip_recall"], "annotator_stored_a_teacher_skip": tot["skip_stored"]}
    (d / "agreement.json").write_text(json.dumps(rep, indent=1, default=float) + "\n")
    (d / "disagreements.jsonl").write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in lines), encoding="utf-8")
    print(json.dumps(rep, indent=1, default=float))


def check(a):
    """Schema check of an annotator's answers (no labels involved)."""
    d = Path(a.dir)
    ids = {json.loads(l)["id"] for l in (d / "packets.jsonl").read_text(encoding="utf-8").splitlines()}
    seen, bad = set(), 0
    for n, l in enumerate((d / "answers.jsonl").read_text(encoding="utf-8").splitlines(), 1):
        if not l.strip():
            continue
        try:
            r = json.loads(l)
        except json.JSONDecodeError as e:
            print(f"line {n}: invalid JSON ({e})")
            bad += 1
            continue
        seen.add(r.get("id"))
        for op in r.get("ops", []):
            _, why = contract.validate_op(op)
            if why:
                print(f"{r.get('id')}: {why}: {json.dumps(op, ensure_ascii=False)[:140]}")
                bad += 1
    print(f"{len(seen & ids)}/{len(ids)} packets answered, {bad} problems, missing: {sorted(ids - seen)[:10]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("packets")
    p.add_argument("--split", required=True)
    p.add_argument("--n", type=int, default=60)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--shards", nargs="*", default=[])
    p.add_argument("--out", required=True)
    c = sub.add_parser("compare")
    c.add_argument("--dir", required=True)
    k = sub.add_parser("check")
    k.add_argument("--dir", required=True)
    a = ap.parse_args()
    {"packets": packets, "compare": compare, "check": check}[a.cmd](a)
