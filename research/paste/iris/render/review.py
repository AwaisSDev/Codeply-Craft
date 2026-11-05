"""Blind meaning review of verified renders (IRISBENCH-PROTOCOL §4 generator rule: "sampled meaning check, 100 renders").

`packets`: sample up to N verified renders per generator (seeded), shuffle all generators together, give each an
anonymous id and write review packets (required items + transcript; no generator name, no gold beyond the items).
The key (anonymous id -> generator, life, event) is written to a separate file the reviewer never reads.
`summarise`: join reviewer verdicts with the key and report, per generator, the share of renders whose text states a
fact contrary to or beyond the gold (the rule's quantity), unfaithful required items, and the rule outcome.

    python -m iris.render.review packets --set NAME=LIVES:RENDERED ... --n 100 --seed 0 --out DIR
    python -m iris.render.review summarise --key DIR/key.json --verdicts V1.jsonl [V2.jsonl ...] --out S.json
Verdict lines: {"rid": "r017", "items_ok": [true, ...], "contrary": ["..."], "extra": ["..."], "note": "..."}.
"""
import argparse
import collections
import json
import os
import random


def packets(sets, n, seed, out):
    pool = []
    for name, spec in sets:
        lives_p, rend_p = spec.split(":", 1)
        evs = {(l["life_id"], e["event_id"]): e for l in map(json.loads, open(lives_p)) for e in l["events"]}
        rows = sorted((r for r in map(json.loads, open(rend_p)) if r.get("ok")), key=lambda r: (r["life_id"], r["event_id"]))
        random.Random(seed).shuffle(rows)
        for r in rows[:n]:
            pool.append((name, r, evs[(r["life_id"], r["event_id"])]))
    random.Random(seed + 1).shuffle(pool)
    os.makedirs(out, exist_ok=True)
    key = {}
    with open(os.path.join(out, "packets.jsonl"), "w") as fh:
        for i, (name, r, ev) in enumerate(pool):
            rid = f"r{i:03d}"
            key[rid] = {"generator": name, "life_id": r["life_id"], "event_id": r["event_id"]}
            fh.write(json.dumps({"rid": rid, "source": ev["source"], "participants": ev["fact_sheet"]["participants"],
                                 "required": [f"[{m.get('speaker', 'user')}] {m['instruction']}" for m in ev["fact_sheet"]["must_express"]],
                                 "transcript": [f"{t['speaker']}: {t['text']}" for t in r["turns"]]}) + "\n")
    json.dump(key, open(os.path.join(out, "key.json"), "w"), indent=1)
    print(json.dumps(collections.Counter(v["generator"] for v in key.values())))


def summarise(key_p, verdict_ps, out, limit=0.05):
    key = json.load(open(key_p))
    v = {}
    for p in verdict_ps:
        for line in open(p):
            if line.strip():
                d = json.loads(line); v[d["rid"]] = d
    by = collections.defaultdict(lambda: collections.Counter())
    for rid, k in key.items():
        c = by[k["generator"]]
        if rid not in v:
            c["unreviewed"] += 1; continue
        d = v[rid]
        c["reviewed"] += 1
        c["contrary"] += bool(d.get("contrary"))
        c["extra"] += bool(d.get("extra"))
        c["contrary_or_extra"] += bool(d.get("contrary") or d.get("extra"))
        c["item_unfaithful"] += not all(d.get("items_ok", [True]))
    rep = {}
    for g, c in sorted(by.items()):
        n = c["reviewed"]
        share = round(c["contrary_or_extra"] / n, 4) if n else None
        rep[g] = {**dict(c), "share_contrary_or_extra": share, "share_item_unfaithful": round(c["item_unfaithful"] / n, 4) if n else None,
                  "meets_rule": (share is not None and share <= limit)}
    json.dump(rep, open(out, "w"), indent=1)
    print(json.dumps(rep, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("packets")
    p.add_argument("--set", action="append", required=True, help="NAME=LIVES.jsonl:RENDERED.jsonl")
    p.add_argument("--n", type=int, default=100)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", required=True)
    s = sub.add_parser("summarise")
    s.add_argument("--key", required=True)
    s.add_argument("--verdicts", nargs="+", required=True)
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.cmd == "packets":
        packets([x.split("=", 1) for x in a.set], a.n, a.seed, a.out)
    else:
        summarise(a.key, a.verdicts, a.out)


if __name__ == "__main__":
    main()
