"""Build episodes: plan -> realize -> assemble -> final records (DATASET-DESIGN.md §7).

    python -m data.build --split pilot --n 100 --seed 1 --realizer programmatic --out <private dir>

Output: <out>/<split>-<realizer>.jsonl (one episode per line) and <out>/<split>-plans.jsonl (realizer-independent plans).
Generated data is written outside the git repository (owner decision 4: private).
"""
import argparse
import copy
import hashlib
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.assemble import assemble  # noqa: E402
from data.plan import Planner  # noqa: E402

DTW_REAL = os.environ.get("PASTE_DTW_REAL", "/home/user/ctx/memarch/research/dtw/data/real")
CLEAN = {"Topical-Chat": "CDLA-Sharing-1.0", "UCI Roman Urdu Data Set (458)": "CC BY 4.0"}
DTW_SPLIT = {"train": "train", "pilot": "train", "val": "val", "test": "test", "stress": "test"}


def real_pool(split):
    """Clean-licence, nothing-to-keep rows from the frozen DtW split mapped to this split (read only)."""
    rows = []
    path = os.path.join(DTW_REAL, f"{DTW_SPLIT[split]}.jsonl")
    if not os.path.exists(path):
        return rows
    for line in open(path):
        r = json.loads(line)
        ds = r.get("source", {}).get("dataset")
        if ds not in CLEAN or r["target"].get("observations") or r["target"].get("plans"):
            continue
        turns = []
        for ev in r["input"]["events"]:
            for ln in ev["text"].split("\n"):
                if ln.startswith("User:"):
                    turns.append({"speaker": "user", "text": ln[5:].strip()})
                elif ln.startswith("Assistant:"):
                    turns.append({"speaker": "assistant", "text": ln[10:].strip()})
                elif turns:
                    turns[-1]["text"] += " " + ln.strip()
                else:
                    turns.append({"speaker": "user", "text": ln.strip()})
        turns = [t for t in turns if t["text"]][:4]
        total, keep = 0, []
        for t in turns:
            if total + len(t["text"]) > 700:
                break
            keep.append(t); total += len(t["text"])
        if keep:
            rows.append({"turns": keep, "source": {"dataset": ds, "licence": CLEAN[ds], "dtw_id": r["id"]}})
    return rows


def finalize(ep_plan, realized, split, realizer_name, ep_id):
    segs = []
    for seg, rz in zip(ep_plan["segments"], realized):
        turns, text, spans = assemble(rz["turns"])
        units = []
        for u in seg["units"]:
            a, b, tx = spans[u["tag"]]
            units.append({**{k: v for k, v in u.items() if k not in ("value", "exact")}, "char_span": [a, b], "text": tx,
                          "value": u["value"] if u.get("exact", True) else tx})
        mentions = []
        for m in seg["mentions"]:
            a, b, tx = spans[m["tag"]]
            mentions.append({**m, "char_span": [a, b], "text": tx})
        out = {k: v for k, v in seg.items() if k not in ("beats", "units", "mentions", "_world")}
        out.update(turns=turns, text=text, units=units, mentions=mentions, families=rz.get("families", []),
                   plan=[{k: v for k, v in b.items() if k != "turns"} for b in seg["beats"]])
        segs.append(out)
    return {"id": ep_id, "split": split, "generator": realizer_name, "world": ep_plan["world"],
            "lookalike_names": ep_plan["lookalike_names"], "segments": segs}


def make_plans(split, n, seed, long=False):
    pool = real_pool(split)
    plans = []
    for i in range(n):
        s = int(hashlib.sha256(f"{split}:{seed}:{i}".encode()).hexdigest()[:8], 16)
        p = Planner(split, s, long=long, max_store=128 if long else 32).plan(pool)
        p["id"] = f"{split}-{seed}-{i:05d}"
        plans.append(p)
    return plans


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=["pilot", "train", "val", "test", "stress"])
    ap.add_argument("--n", type=int, required=True)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if os.path.abspath(a.out).startswith(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))):
        sys.exit("refusing to write generated data inside the git repository (owner decision 4)")
    os.makedirs(a.out, exist_ok=True)
    from data.realize_prog import ProgRealizer
    plans = make_plans(a.split, a.n, a.seed, long=a.split == "stress")
    with open(os.path.join(a.out, f"{a.split}-plans.jsonl"), "w") as f:
        for p in plans:
            f.write(json.dumps(p, default=sorted) + "\n")
    with open(os.path.join(a.out, f"{a.split}-programmatic.jsonl"), "w") as f:
        for p in plans:
            rz = ProgRealizer(a.split, int(hashlib.sha256(p["id"].encode()).hexdigest()[:8], 16)).realize(copy.deepcopy(p))
            f.write(json.dumps(finalize(p, rz, a.split, "programmatic", p["id"]), default=sorted) + "\n")
    print(f"wrote {len(plans)} episodes to {a.out}")


if __name__ == "__main__":
    main()
