"""Summaries and paired comparisons for LongMemEval runs (PUBLIC-BENCHMARK-PLAN.md).

Primary set: all questions except single-session-assistant and abstention. Per system: seed-mean of each metric
(per-seed values listed); for pairs, the difference of seed-means with a 95 % paired bootstrap over questions
(10,000 resamples; seeds kept together). Also per question type.

    python tools/public_compare.py --sys PASTE=a.jsonl,b.jsonl,c.jsonl M1c=... [--pairs PASTE:M1c] --out OUT.json
"""
import argparse
import json
import random

METRICS = ("evidence_recall@10", "evidence_recall@5", "answer_in_memory", "evidence_captured_rate", "memories_per_100_turns")


def load(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    for r in rows:
        r["evidence_captured_rate"] = r["evidence_captured"] / r["n_evidence"] if r["n_evidence"] else None
        r["memories_per_100_turns"] = 100 * r["n_memories"] / max(1, r["n_turns"])
    return {r["question_id"]: r for r in rows}


def primary(r):
    return r["question_type"] != "single-session-assistant" and not r["abstention"]


def mean(xs):
    xs = [float(x) for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def seed_mean(seeds, qids, m):
    vals = [mean(s[q][m] for q in qids) for s in seeds]
    vals = [v for v in vals if v is not None]
    return sum(vals) / len(vals) if vals else None


def boot(A, B, qids, m, n=10_000, seed=0):
    rng = random.Random(seed)
    d0 = seed_mean(A, qids, m) - seed_mean(B, qids, m)
    ds = sorted(seed_mean(A, s, m) - seed_mean(B, s, m) for s in ([qids[rng.randrange(len(qids))] for _ in qids] for _ in range(n)))
    return d0, ds[int(0.025 * n)], ds[int(0.975 * n) - 1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sys", nargs="+", required=True, help="NAME=run1.jsonl,run2.jsonl,...")
    ap.add_argument("--pairs", nargs="*", default=[])
    ap.add_argument("--n-boot", type=int, default=10_000)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    S = {}
    for spec in a.sys:
        name, files = spec.split("=", 1)
        S[name] = [load(f) for f in files.split(",")]
    common = sorted(set.intersection(*[set(s) for seeds in S.values() for s in seeds]))
    ref = S[next(iter(S))][0]
    prim = [q for q in common if primary(ref[q])]
    types = sorted({ref[q]["question_type"] for q in common})
    rep = {"questions_common": len(common), "primary_questions": len(prim), "systems": {}, "pairs": {}}
    for name, seeds in S.items():
        rep["systems"][name] = {"seeds": len(seeds),
                                "primary": {m: round(seed_mean(seeds, prim, m), 4) for m in METRICS},
                                "primary_per_seed": {m: [round(mean(s[q][m] for q in prim), 4) for s in seeds] for m in METRICS},
                                "by_type": {t: {m: round(seed_mean(seeds, [q for q in common if ref[q]["question_type"] == t and not ref[q]["abstention"]], m) or 0, 4)
                                                for m in ("evidence_recall@10", "answer_in_memory")} for t in types}}
    for pr in a.pairs:
        A, B = pr.split(":")
        rep["pairs"][f"{A} - {B}"] = {m: dict(zip(("delta", "lo", "hi"), (round(x, 4) for x in boot(S[A], S[B], prim, m, a.n_boot))))
                                      for m in ("evidence_recall@10", "evidence_recall@5", "answer_in_memory")}
    json.dump(rep, open(a.out, "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
