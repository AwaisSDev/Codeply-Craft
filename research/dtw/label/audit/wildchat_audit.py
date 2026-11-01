#!/usr/bin/env python3
"""WildChat provenance, privacy and contamination audit of the frozen DtW data (counts only).

Reads the WildChat-1M shard our examples came from (pinned revision) and every frozen file that uses it.
Prints and writes aggregate counts only: no hashed IP, header, location or conversation text leaves this
script. Run with an isolated interpreter (python -I) because the shard is downloaded data.

  python -I research/dtw/label/audit/wildchat_audit.py <shard.parquet> <out.json>
"""
import collections, hashlib, json, os, re, sys

import pyarrow.parquet as pq

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
FILES = {"train": "research/dtw/data/real/train.jsonl", "val": "research/dtw/data/real/val.jsonl",
         "test-real": "research/dtw/data/real/test.jsonl", "natural-300": "research/dtw/label/data/fullnat.jsonl",
         "benchmark-520": "research/dtw/benchmark/bench.jsonl"}
REVISION = "7d6490e462285cf85d91eabea0f9a954fbddcd1f"
SHARD_SHA = "abec2a13129db8c0e6a2d3a51ff12644873c748205a6fdf6551fbcb34430e51c"
# Residual-PII patterns, run on the text the models read (events) and on the labels (target values).
PII = {
    "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "phone": re.compile(r"(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)"),
    "ipv4": re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)"),
    "url": re.compile(r"https?://\S+|www\.\S+"),
    "card_like": re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)"),
    "long_digits": re.compile(r"(?<!\d)\d{9,}(?!\d)"),
}
QUASI = ("hashed_ip", "header", "user-agent", "accept-language", "country", "state", "timestamp", "turn_identifier")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def texts(row):
    ev = " ".join(e.get("text", "") for e in (row.get("input") or {}).get("events", []))
    lab = " ".join(f"{o.get('value', '')} {o.get('text', '')}" for o in (row.get("target") or {}).get("observations", []))
    return ev, lab


def main():
    shard, out = sys.argv[1], sys.argv[2]
    rep = {"revision": REVISION, "shardSha256Matches": sha256(shard) == SHARD_SHA}
    t = pq.read_table(shard, columns=["conversation_hash", "hashed_ip", "toxic", "redacted", "country", "language", "timestamp", "model"])
    meta = {r["conversation_hash"]: r for r in t.to_pylist()}
    rep["shardRows"] = len(meta)

    rows = {k: [json.loads(l) for l in open(os.path.join(ROOT, p))] for k, p in FILES.items()}
    wc = {k: [r for r in v if "WildChat" in str((r.get("source") or {}).get("dataset", ""))] for k, v in rows.items()}
    rep["examples"] = {k: {"all": len(rows[k]), "wildchat": len(wc[k]),
                           "synthetic_rewrites": sum(1 for r in wc[k] if (r.get("source") or {}).get("synthetic"))} for k in rows}

    # Provenance: every record pinned to this revision and shard, and its conversation present in the shard.
    prov = collections.Counter()
    for k, v in wc.items():
        for r in v:
            s = r["source"]
            prov["records"] += 1
            prov["revision_ok"] += s.get("revision") == REVISION
            prov["shard_sha_ok"] += s.get("sha256") == SHARD_SHA
            prov["conversation_found"] += s.get("original_id") in meta
    rep["provenance"] = dict(prov)

    # Quasi-identifiers: none of the shard's per-user fields may appear in our files.
    leaked_keys = collections.Counter()
    for k, v in wc.items():
        for r in v:
            blob = json.dumps({kk: vv for kk, vv in r.items() if kk != "source"}).lower()
            for q in QUASI:
                if f'"{q}"' in blob:
                    leaked_keys[q] += 1
    rep["quasiIdentifierFieldsInOurFiles"] = dict(leaked_keys)

    # Contamination inside the data: same user (hashed IP) in more than one split; same conversation.
    user_splits = collections.defaultdict(set)
    conv_splits = collections.defaultdict(set)
    for k, v in wc.items():
        for r in v:
            m = meta.get(r["source"].get("original_id"))
            conv_splits[r["source"].get("original_id")].add(k)
            if m and m["hashed_ip"]:
                user_splits[m["hashed_ip"]].add(k)
    rep["conversationsInMoreThanOneFile"] = sum(1 for s in conv_splits.values() if len(s) > 1)
    pair = collections.Counter()
    for s in user_splits.values():
        for a in s:
            for b in s:
                if a < b:
                    pair[f"{a} & {b}"] += 1
    rep["usersByFileCount"] = dict(collections.Counter(len(s) for s in user_splits.values()))
    rep["usersSharedBetweenFiles"] = dict(pair)
    # Examples in an evaluation file whose user also appears in train.
    train_users = {u for u, s in user_splits.items() if "train" in s}
    rep["evalExamplesWhoseUserIsInTrain"] = {}
    for k in ("val", "test-real", "natural-300"):
        n = 0
        for r in wc[k]:
            m = meta.get(r["source"].get("original_id"))
            n += bool(m and m["hashed_ip"] in train_users)
        rep["evalExamplesWhoseUserIsInTrain"][k] = {"examples": n, "of": len(wc[k])}
    top = sorted((sum(1 for k in wc for r in wc[k] if (meta.get(r["source"].get("original_id")) or {}).get("hashed_ip") == u), u)
                 for u in user_splits)[-5:]
    rep["largestUsersExampleCounts"] = [c for c, _ in top]

    # Content flags from the publisher (whole conversation).
    flags = collections.Counter()
    for k, v in wc.items():
        for r in v:
            m = meta.get(r["source"].get("original_id")) or {}
            flags[f"{k}:toxic"] += bool(m.get("toxic"))
            flags[f"{k}:redacted_by_publisher"] += bool(m.get("redacted"))
    rep["publisherFlags"] = dict(flags)
    ts = [m["timestamp"] for k in wc for r in wc[k] if (m := meta.get(r["source"].get("original_id")))]
    rep["conversationDates"] = {"from": str(min(ts))[:10], "to": str(max(ts))[:10]} if ts else None
    rep["countriesTop"] = collections.Counter((meta.get(r["source"].get("original_id")) or {}).get("country") for k in wc for r in wc[k]).most_common(8)

    # Residual PII patterns in what the models read and in the labels.
    pii = collections.Counter()
    for k, v in wc.items():
        for r in v:
            ev, lab = texts(r)
            for name, rx in PII.items():
                if rx.search(ev):
                    pii[f"{k}:events:{name}"] += 1
                if rx.search(lab):
                    pii[f"{k}:labels:{name}"] += 1
    rep["residualPiiPatternExamples"] = dict(sorted(pii.items()))
    json.dump(rep, open(out, "w"), indent=1, default=str)
    print(json.dumps(rep, indent=1, default=str))


if __name__ == "__main__":
    main()
