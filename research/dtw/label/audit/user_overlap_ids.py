#!/usr/bin/env python3
"""Example ids of val / test-real / natural-300 whose WildChat user (hashed IP) also appears in train.
Writes only our own example ids (no hashed IP, no text). Run with python -I.
  python -I research/dtw/label/audit/user_overlap_ids.py <shard.parquet> <out.json>"""
import json, os, sys
import pyarrow.parquet as pq
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
F = {"train": "research/dtw/data/real/train.jsonl", "val": "research/dtw/data/real/val.jsonl",
     "test-real": "research/dtw/data/real/test.jsonl", "natural-300": "research/dtw/label/data/fullnat.jsonl"}
t = pq.read_table(sys.argv[1], columns=["conversation_hash", "hashed_ip"]).to_pylist()
ip = {r["conversation_hash"]: r["hashed_ip"] for r in t}
rows = {k: [json.loads(l) for l in open(os.path.join(ROOT, p))] for k, p in F.items()}
user = lambda r: ip.get((r.get("source") or {}).get("original_id")) if "WildChat" in str((r.get("source") or {}).get("dataset", "")) else None
train_users = {u for r in rows["train"] if (u := user(r))}
out = {}
for k in ("val", "test-real", "natural-300"):
    out[k] = {"userInTrain": sorted(r["id"] for r in rows[k] if user(r) in train_users),
              "wildchatUserNotInTrain": sorted(r["id"] for r in rows[k] if user(r) and user(r) not in train_users),
              "notWildchat": sorted(r["id"] for r in rows[k] if not user(r))}
json.dump(out, open(sys.argv[2], "w"), indent=0)
print({k: {kk: len(vv) for kk, vv in v.items()} for k, v in out.items()})
