"""Frozen family split of the realistic labelled set (MODEL-SELECTION-PROTOCOL.md §1).

  python3 split.py --out ../data/real data/full.jsonl data/fullsyn.jsonl data/pilot2.jsonl data/pilot2plans.jsonl \
      --natural data/fullnat.jsonl --bench ../benchmark/bench.jsonl

Family = source dataset + original id: a real conversation, its merge variant
(-mg) and its synthetic Roman Urdu / mixed rewrite share a family. Split by
sha1("split-v1:" + family): 80 % train, 10 % val, 10 % test. Leak checks:
ids or families in two splits; Benchmark-520 text in train / val (exact or
>= 0.9 character-trigram Jaccard); natural-sample examples in train; known
memories in a train / val example that are labels of a test example (merge
distractors), which are dropped from that split. Writes train / val / test
.jsonl, split.jsonl, and SPLIT.json (counts, hashes, leak checks).
"""
import argparse
import collections
import hashlib
import json
import os
import re


def read(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


def family(ex):
    s = ex.get("source", {})
    return f"{s.get('dataset', '?')}:{s.get('original_id', ex['id'])}"


def split_of(fam):
    h = int(hashlib.sha1(f"split-v1:{fam}".encode()).hexdigest()[:8], 16) % 100
    return "train" if h < 80 else ("val" if h < 90 else "test")


def trigrams(t):
    t = re.sub(r"\s+", " ", t.lower())
    return {t[i:i + 3] for i in range(len(t) - 2)}


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--natural", required=True)
    ap.add_argument("--bench", required=True)
    a = ap.parse_args()
    rows, seen = [], set()
    for f in a.files:
        for r in read(f):
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            rows.append(r)
    # The natural sample stays an unbiased random sample: conversations it shares
    # with the labelled pool are removed from the pool (all splits), not from it.
    nat = read(a.natural)
    nat_fams = {family(r) for r in nat}
    removed_natural = sum(family(r) in nat_fams for r in rows)
    rows = [r for r in rows if family(r) not in nat_fams]
    by = {"train": [], "val": [], "test": []}
    for r in rows:
        by[split_of(family(r))].append(r)

    checks = {}
    # ids / families in two splits
    fam_split = collections.defaultdict(set)
    id_split = collections.defaultdict(set)
    for k, rs in by.items():
        for r in rs:
            fam_split[family(r)].add(k)
            id_split[r["id"]].add(k)
    checks["families_in_two_splits"] = sum(len(v) > 1 for v in fam_split.values())
    checks["ids_in_two_splits"] = sum(len(v) > 1 for v in id_split.values())
    # natural-sample examples in train (by id and by family)
    nat_ids = {r["id"] for r in nat}
    checks["removed_for_natural_overlap"] = removed_natural
    checks["natural_ids_in_train"] = sum(r["id"] in nat_ids for r in by["train"])
    checks["natural_families_in_train_or_val"] = sum(family(r) in nat_fams for r in by["train"] + by["val"])
    # Benchmark-520 overlap
    bench_texts = [e["text"] for b in read(a.bench) for e in b["input"]["events"]]
    bench_exact = set(bench_texts)
    bench_tri = [trigrams(t) for t in bench_texts]
    exact = near = 0
    for r in by["train"] + by["val"]:
        for e in r["input"]["events"]:
            if e["text"] in bench_exact:
                exact += 1
                continue
            tt = trigrams(e["text"])
            if any(len(tt & bt) / max(1, len(tt | bt)) >= 0.9 for bt in bench_tri if abs(len(bt) - len(tt)) < 0.2 * max(len(bt), len(tt))):
                near += 1
    checks["bench_exact_in_train_val"] = exact
    checks["bench_near_in_train_val"] = near
    # merge distractors carrying labels of examples in another split
    label_split = collections.defaultdict(set)
    for k, rs in by.items():
        for r in rs:
            for o in r["target"]["observations"]:
                label_split[(o["slot"], o["value"])].add(k)
    dropped = collections.Counter()
    for k in ("train", "val"):
        keep = []
        for r in by[k]:
            other = any(any(s != k for s in label_split.get((m["slot"], m["value"]), set()) - {k}) and not (label_split.get((m["slot"], m["value"]), set()) & {k})
                        for m in r["input"].get("known", []))
            if other:
                dropped[k] += 1
            else:
                keep.append(r)
        by[k] = keep
    checks["dropped_for_cross_split_known_memories"] = dict(dropped)

    os.makedirs(a.out, exist_ok=True)
    hashes = {}
    for k, rs in by.items():
        rs.sort(key=lambda r: r["id"])
        p = os.path.join(a.out, f"{k}.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for r in rs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        hashes[k] = sha(p)
    with open(os.path.join(a.out, "split.jsonl"), "w") as f:
        for k, rs in by.items():
            for r in rs:
                f.write(json.dumps({"id": r["id"], "family": family(r), "split": k}) + "\n")
    hashes["split"] = sha(os.path.join(a.out, "split.jsonl"))

    def stratum(r):
        if r["id"].endswith("-mg"):
            return "merge"
        return r.get("stratum") or (r.get("source", {}).get("synthetic") and f"syn-{r['source']['synthetic']['language']}") or r["id"].split("-")[1]

    def stats(rs):
        c = collections.Counter(stratum(r) for r in rs)
        empty = sum(not [o for o in r["target"]["observations"] if o["certainty"] in ("stated", "implied", "temporary")] and not r["target"]["plans"] for r in rs)
        return {"n": len(rs), "empty": empty, "strata": dict(sorted(c.items()))}

    summary = {"inputs": {f: sha(f) for f in a.files}, "rule": "sha1('split-v1:' + family) % 100: <80 train, <90 val, else test",
               "splits": {k: stats(v) for k, v in by.items()}, "hashes": hashes, "leakChecks": checks}
    must_be_zero = ["families_in_two_splits", "ids_in_two_splits", "natural_ids_in_train", "natural_families_in_train_or_val", "bench_exact_in_train_val", "bench_near_in_train_val"]
    summary["leakChecksPass"] = all(checks[k] == 0 for k in must_be_zero)
    json.dump(summary, open(os.path.join(a.out, "SPLIT.json"), "w"), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
