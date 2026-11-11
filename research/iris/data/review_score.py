#!/usr/bin/env python3
"""Score a blind-review set whose key lives outside the repo: python review_score.py <review dir> <key.jsonl> [--dump disagreements.json]"""
import json, sys
from collections import Counter
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from codeply_iris import contract, metrics

d, keyf = Path(sys.argv[1]), sys.argv[2]
key = {r["id"]: r for r in map(json.loads, open(keyf, encoding="utf-8"))}
ans = {r["id"]: r for r in map(json.loads, open(d / "answers.jsonl", encoding="utf-8")) if r}
tot, flagged, dis = Counter(), 0, []
for pid, k in key.items():
    parsed = contract.parse(json.dumps({"ops": ans[pid].get("ops", [])}))
    ops, rej = contract.guard(parsed["ops"], k["messages"], k["memories"], k["source"])
    c, _ = metrics.score_observe(ops, k["gold"], k["memories"], rej)
    tot.update(c)
    miss, extra = c["gold_content"] - c["tp"], c["pred_content"] - c["tp"] - c["dup_restated"]
    if miss or extra or c["confirm_gold"] != c["confirm_tp"] or c["retract_gold"] != c["retract_tp"] or parsed["dropped"] or rej:
        flagged += 1
        dis.append({"id": pid, "teacher_only": miss, "annotator_only": extra, "messages": k["messages"],
                    "teacher": [{x: g.get(x) for x in ("op", "ref", "ent", "attr", "val", "when", "evid")} for g in k["gold"] if g["op"] != "skip"],
                    "annotator": [{x: o.get(x) for x in ("op", "ref", "ent", "attr", "val", "when", "evid")} for o in ops if o["op"] != "skip"]})
s = metrics.summarise(tot)
print(json.dumps({"sessions": len(key), "agreement_f1": round(s["extraction_f1"], 3), "teacher_found": round(s["extraction_recall"], 3),
                  "annotator_labelled": round(s["extraction_precision"], 3), "disagreement_sessions": flagged, "skip_recall": round(s["skip_recall"], 2)}))
if "--dump" in sys.argv:
    json.dump(dis, open(sys.argv[sys.argv.index("--dump") + 1], "w"), ensure_ascii=False, indent=1)
