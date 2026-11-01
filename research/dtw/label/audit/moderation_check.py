#!/usr/bin/env python3
"""Publisher moderation signals for every WildChat conversation in the frozen DtW files (counts only).
Prints example ids only where a minors-related flag fires, so they can be removed; no text.
  python -I research/dtw/label/audit/moderation_check.py <shard.parquet> <out.json>"""
import collections, json, os, sys
import pyarrow.parquet as pq
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
F = {"train": "research/dtw/data/real/train.jsonl", "val": "research/dtw/data/real/val.jsonl",
     "test-real": "research/dtw/data/real/test.jsonl", "natural-300": "research/dtw/label/data/fullnat.jsonl"}
t = pq.read_table(sys.argv[1], columns=["conversation_hash", "openai_moderation", "detoxify_moderation"]).to_pylist()
mod = {r["conversation_hash"]: r for r in t}
MINORS = ("sexual/minors", "sexual_minors")
out = {"counts": {}, "minorsFlagIds": {}, "thresholds": "flag = OpenAI moderation category true; score>0.5 = category score above 0.5"}
for k, p in F.items():
    c = collections.Counter(); ids = []
    for l in open(os.path.join(ROOT, p)):
        r = json.loads(l); s = r.get("source") or {}
        if "WildChat" not in str(s.get("dataset", "")):
            continue
        m = mod.get(s.get("original_id"))
        if not m:
            c["missing"] += 1; continue
        c["conversations"] += 1
        turns = m["openai_moderation"] or []
        anyflag = any(x.get("flagged") for x in turns)
        minors = any((x.get("categories") or {}).get(cat) for x in turns for cat in MINORS)
        minors_score = max([(x.get("category_scores") or {}).get(cat) or 0 for x in turns for cat in MINORS] or [0])
        sexual = any((x.get("categories") or {}).get("sexual") for x in turns)
        c["anyTurnFlagged"] += anyflag; c["sexualFlag"] += sexual; c["minorsFlag"] += minors
        c["minorsScore>0.1"] += minors_score > 0.1; c["minorsScore>0.5"] += minors_score > 0.5
        tox = max([x.get("toxicity") or 0 for x in (m["detoxify_moderation"] or [])] or [0])
        c["detoxifyToxicity>0.5"] += tox > 0.5
        if minors or minors_score > 0.1:
            ids.append(r["id"])
    out["counts"][k] = dict(c); out["minorsFlagIds"][k] = ids
json.dump(out, open(sys.argv[2], "w"), indent=1)
print(json.dumps(out["counts"], indent=1)); print({k: len(v) for k, v in out["minorsFlagIds"].items()})
