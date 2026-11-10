"""Teacher episodes -> model examples (observe + retrieve), with exact targets for every store variant.

    python -m codeply_iris.build --raw data/raw --out data/built [--seed 1]

Per split it writes <split>.jsonl and, once, MANIFEST.json (counts, sha256, leakage checks).

Store variants (train only; evaluation splits get the gold store, the closed loop is run by evaluate.py):
  gold    every fact the episode established so far, plus unrelated memories from other episodes
  noisy   the same store with facts dropped at random (a missed fact's later update must become an add), the
          occasional wrong value (the model must correct it when the input restates the truth), and other
          distractors: a cheap stand-in for the model's own imperfect history; evaluate.py --closed-loop and
          selfplay.py produce the real thing.
"""
import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

from . import contract, prompt
from .store import MemoryStore, derive_ops

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data"))
import validate_raw  # noqa: E402  (data/validate_raw.py)

SPLITS = ("train", "val", "test")


def load_raw(raw_dir, split):
    """Valid episodes of a split, plus the count of rejected ones."""
    eps, bad = [], []
    for path in sorted(Path(raw_dir, split).glob("*.jsonl")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                ep = json.loads(line)
            except json.JSONDecodeError:
                bad.append(f"{path.name}:{n}: invalid JSON")
                continue
            errors, _ = validate_raw.check_episode(ep, split)
            if errors:
                bad.append(f"{path.name}:{n}: {errors[0]}")
                continue
            ep["shard"] = path.stem
            eps.append(ep)
    return eps, bad


def name_tokens(ep):
    """Lower-case name tokens of every entity and speaker in an episode (for distractor exclusion)."""
    out = set()
    for s in ep["sessions"]:
        for m in s["messages"]:
            out.update(re.findall(r"[a-z]+", m["who"].lower()))
        for f in s.get("facts", []) or []:
            if "ent" in f:
                out.update(contract.norm(f["ent"]).split())
            for r in f.get("rel", []) or []:
                out.update(contract.norm(r).split())
    return out - {"user", "assistant", "email", "from", "calendar", "note", "screen"}


def distractor_pool(episodes):
    """Final-state facts about non-user entities, per episode: the raw material for unrelated memories."""
    pool = []
    for ep in episodes:
        final = {}
        for s in ep["sessions"]:
            for f in s.get("facts", []) or []:
                if "retract" in f:
                    final.pop(f["key"], None)
                elif f["etype"] != "user":
                    final[f["key"]] = f
        for f in final.values():
            pool.append((ep["id"], f))
    return pool


def replay(ep):
    """Yield (session, gold_store_before) for each session; the store carries key provenance."""
    store = MemoryStore()
    for s in ep["sessions"]:
        today = s["now"][:10]
        yield s, store, today
        for op in derive_ops(s, store.view(today)):
            if op["op"] != "skip":
                store.apply({k: v for k, v in op.items() if k != "key"}, session=s["sid"], key=op.get("key"))


def ledger(ep):
    """Final ground truth of an episode: key -> {ent, attr, val, when, live, past: [(val, when)]}."""
    led = {}
    for s in ep["sessions"]:
        for f in s.get("facts", []) or []:
            k = f["key"]
            if "retract" in f:
                if k in led:
                    led[k]["live"] = False
                continue
            if k in led and contract.norm(led[k]["val"]) != contract.norm(f["val"]):
                led[k]["past"].append((led[k]["val"], led[k].get("when")))
            past = led[k]["past"] if k in led else []
            led[k] = {"ent": f["ent"], "attr": f["attr"], "val": f["val"], "when": f.get("when"), "live": True, "past": past,
                      "keep": f["persist"], "until": f.get("until")}
    return led


def mem_row(f, key):
    row = {"ent": f["ent"], "type": f["etype"], "attr": f["attr"], "val": contract.squash(f["val"]), "kind": f["kind"],
           "keep": f["persist"], "key": key}
    for k in ("when", "until"):
        if f.get(k):
            row[k] = f[k]
    return row


def with_ids(rows, rng):
    """Shuffle and give the rows fresh short ids (real stores have arbitrary ids; position must not matter)."""
    rows = [dict(r) for r in rows]
    rng.shuffle(rows)
    for r, n in zip(rows, rng.sample(range(1, 400), len(rows))):
        r["id"] = f"m{n}"
    return rows


def pick_distractors(pool, ep, rng, n, today):
    if n <= 0:
        return []
    taken = name_tokens(ep)
    cands = [f for eid, f in pool if eid != ep["id"] and not (set(contract.norm(f["ent"]).split()) & taken)
             and not (f["persist"] == "temp" and f.get("until", "9") < today)]
    rng.shuffle(cands)
    out, seen = [], set()
    for f in cands:
        sig = (contract.norm(f["ent"]), f["attr"])
        if sig in seen:
            continue
        seen.add(sig)
        row = mem_row(f, None)
        if row["keep"] == "temp":
            row["until"] = max(row.get("until", today), today)
        out.append(row)
        if len(out) >= n:
            break
    return out


def observe_example(ep, s, rows, split, variant):
    ops = derive_ops(s, rows)
    shown = [{k: v for k, v in r.items() if k != "key"} for r in rows]
    return {"id": f"{ep['id']}-s{s['sid']}-{variant}", "task": "observe", "split": split, "episode": ep["id"],
            "shard": ep.get("shard"), "sid": s["sid"], "variant": variant, "lang": ep["lang"], "source": s["source"],
            "now": s["now"], "memories": rows, "messages": s["messages"],
            "prompt": prompt.observe_prompt(s["now"], s["source"], shown, s["messages"]),
            "target": contract.dumps(ops), "gold": ops}


def build_split(episodes, split, seed, wrong_pool=None):
    rng = random.Random(f"iris-build-{split}-{seed}")
    pool = distractor_pool(episodes)
    out = []
    for ep in episodes:
        for s, store, today in replay(ep):
            gold_rows = store.view(today)
            n_d = rng.choice((0, 0, 2, 4, 6, 10) if split == "train" else (0, 3, 6))
            rows = with_ids(gold_rows + pick_distractors(pool, ep, rng, n_d, today), rng)
            out.append(observe_example(ep, s, rows, split, "gold"))
            if split != "train" or not gold_rows:
                continue
            if rng.random() < 0.5:
                continue                                  # a noisy-store copy for half the sessions (token budget)
            # noisy store: drop facts, sometimes corrupt a value that this session restates, new distractors
            keep, restated = [], {f["key"] for f in s.get("facts", []) or [] if "retract" not in f}
            for r in gold_rows:
                if rng.random() < 0.35:
                    continue
                r = dict(r)
                if r["key"] in restated and rng.random() < 0.2:
                    others = [f for _, f in pool if f["kind"] == r["kind"] and contract.norm(f["val"]) != contract.norm(r["val"])]
                    if others:
                        r["val"] = contract.squash(rng.choice(others)["val"])
                        r.pop("when", None)
                keep.append(r)
            rows = with_ids(keep + pick_distractors(pool, ep, rng, rng.choice((0, 3, 8, 14)), today), rng)
            out.append(observe_example(ep, s, rows, split, "noisy"))
        # retrieval
        for qi, q in enumerate(ep.get("queries", []) or [], 1):
            store = MemoryStore()
            for s in ep["sessions"][:q["after"]]:
                for op in derive_ops(s, store.view(s["now"][:10])):
                    if op["op"] != "skip":
                        store.apply({k: v for k, v in op.items() if k != "key"}, session=s["sid"], key=op.get("key"))
            today = q["now"][:10]
            live = store.view(None)                 # expired temp items stay in as traps; they are never gold
            drill = str(ep.get("shard", "")).startswith("syn")
            for variant in ("a",):
                n_d = rng.choice((2, 6, 12, 18))
                rows = with_ids(live + pick_distractors(pool, ep, rng, n_d, today), rng)
                gold = [r["id"] for r in rows if r.get("key") in set(q["relevant"])]
                shown = [{k: v for k, v in r.items() if k != "key"} for r in rows]
                out.append({"id": f"{ep['id']}-q{qi}-{variant}", "task": "retrieve", "split": split, "episode": ep["id"],
                            "shard": ep.get("shard"), "variant": variant, "lang": ep["lang"], "now": q["now"],
                            "query": q["query"], "memories": rows,
                            "prompt": prompt.retrieve_prompt(q["now"], shown, q["query"]),
                            "target": contract.dumps_use(gold), "gold_use": gold,
                            "trap": [r["id"] for r in rows if r.get("key") in set(q.get("trap", []) or [])]})
    return out


def shingles(text, n=5):
    w = contract.norm(text).split()
    return {" ".join(w[i:i + n]) for i in range(max(len(w) - n + 1, 0))}


def leakage(splits):
    """Cross-split checks: shared person names, shared non-user entities, near-duplicate session texts."""
    rep = {}
    ents, texts = {}, {}
    for split, eps in splits.items():
        ents[split] = {contract.norm(f["ent"]) for ep in eps for s in ep["sessions"] for f in s.get("facts", []) or []
                       if f.get("etype") in ("person", "org", "project")}
        texts[split] = [(ep["id"], s["sid"], shingles(" ".join(m["text"] for m in s["messages"])))
                        for ep in eps for s in ep["sessions"]]
    for a, b in (("train", "val"), ("train", "test"), ("val", "test")):
        shared = sorted(ents.get(a, set()) & ents.get(b, set()))
        dups = []
        for ida, sa, sha in texts.get(a, []):
            for idb, sb, shb in texts.get(b, []):
                if sha and shb and len(sha & shb) / min(len(sha), len(shb)) > 0.3:
                    dups.append(f"{ida}/s{sa} ~ {idb}/s{sb}")
        rep[f"{a}-{b}"] = {"shared_entities": shared, "near_duplicate_sessions": dups}
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--out", default="data/built")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"contract": contract.VERSION, "seed": a.seed, "splits": {}}
    splits = {}
    for split in SPLITS:
        eps, bad = load_raw(a.raw, split)
        splits[split] = eps
        ex = build_split(eps, split, a.seed)
        text = "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in ex)
        (out / f"{split}.jsonl").write_text(text, encoding="utf-8")
        ops = Counter(o["op"] for e in ex if e["task"] == "observe" for o in e["gold"])
        manifest["splits"][split] = {
            "episodes": len(eps), "rejected_episodes": bad, "sessions": sum(len(ep["sessions"]) for ep in eps),
            "examples": len(ex), "observe": sum(e["task"] == "observe" for e in ex),
            "retrieve": sum(e["task"] == "retrieve" for e in ex),
            "empty_targets": sum(e["task"] == "observe" and not e["gold"] for e in ex), "ops": dict(ops),
            "langs": dict(Counter(ep["lang"] for ep in eps)), "sha256": hashlib.sha256(text.encode()).hexdigest()}
        print(split, json.dumps({k: v for k, v in manifest["splits"][split].items() if k != "rejected_episodes"}))
        for b in bad:
            print("  REJECTED", b)
    manifest["leakage"] = leakage(splits)
    for pair, rep in manifest["leakage"].items():
        print(f"leakage {pair}: {len(rep['shared_entities'])} shared entities, "
              f"{len(rep['near_duplicate_sessions'])} near-duplicate sessions")
    (out / "MANIFEST.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
