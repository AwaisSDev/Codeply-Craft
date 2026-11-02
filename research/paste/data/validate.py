"""Dataset validator (DATASET-DESIGN.md §8). Every check is independent of the planner's own bookkeeping.

    python -m data.validate <file.jsonl> [<file.jsonl> ...] [--splits-dir DIR]

Checks per episode:
  V1  spans: every unit/mention span lies inside the segment text and equals its recorded text; exact units equal
      their gold value; unit spans do not overlap each other
  V2  persistent replay: gold ops replayed through paste.brain_sim from the first store reproduce every later
      store_before (ids, values, statuses, evidence)
  V3  temporary replay: gold temp ops + the adapter's deterministic rules reproduce every later temp_before
  V4  targets: record targets exist in store_before; NEW-ATTR profiles exist (or are the user); NEW-ENT entities
      have no record; PROMOTE sources are PENDING items in temp_before; temp targets exist
  V5  label consistency: IGNORE units carry joking/hypothetical/quoting; PERSIST units carry stated/implied;
      TEMP units carry a temporary type and TTL; relations only on record targets
  V6  merges are licensed by a PERSIST unit on one of the pair's profiles (amendment D1)
Across files (leakage):
  L1  no test-only value appears in train/val/pilot;  L2  entity names are disjoint across splits;
  L3  template family C appears only in test/stress;  L4  identical user-turn texts shared between splits
"""
import argparse
import collections
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from paste.brain_sim import BrainSim  # noqa: E402

from data import ontology as O  # noqa: E402

DAY = 86400.0


def replay_store(seg, store):
    b = BrainSim(capacity=10_000)
    for r in store:
        b.records[r["id"]] = copy.deepcopy(r)
    b.t = max([r["updated"] for r in store] + [0])
    for op in seg["gold_ops"]:
        if op["op"] == "WRITE":
            b.add(op["entity"], op["entity"], {"attribute": op["attribute"], "value": op["value"], "kind": op["kind"],
                                               "certainty": op["certainty"]}, provenance=op["fact"], rid=op["fact"])
        elif op["op"] in ("UPDATE", "MERGE_INTO"):
            b.apply({"op": op["op"], "target": op["fact"], "challenge": op.get("subtype") == "CONTRADICTION",
                     "payload": {"attribute": op["attribute"], "value": op["value"], "certainty": op["certainty"]}})
        elif op["op"] == "FORGET":
            b.apply({"op": "FORGET", "target": op["fact"]})
        elif op["op"] == "FORGET_PROFILE":
            b.apply({"op": "FORGET_PROFILE", "entity": op["entity"]})
        elif op["op"] == "MERGE":
            b.apply({"op": "MERGE", "target": op["facts"][0], "with": op["facts"][1]})
    return b.records


def same_store(a, b):
    key = lambda r: (r["id"], r["attribute"], str(r["value"]), r["status"], r["evidence"], r["entity"])
    return sorted(map(key, a)) == sorted(map(key, b.values() if isinstance(b, dict) else b))


def replay_temp(seg, temp, nxt):
    """Gold temp ops of `seg` applied to `temp`, then the deterministic rules at the start of `nxt`."""
    items = copy.deepcopy(temp)
    by_unit = {u["tag"]: u for u in seg["units"]}
    for op in seg["temp_ops"]:
        if op["op"] == "T-WRITE":
            u = by_unit[op["unit"]]
            from paste.text import resolve_until
            items.append({"id": op["item"], "type": u["ttype"], "ttl": u["ttl"],
                          "until": resolve_until(u["value"], seg["at"]) if u["ttl"] == "UNTIL" else None,
                          "created_at": seg["at"], "created_seg": seg["index"], "text": u["value"][:280]})
            while len(items) > 8:
                sess = [i for i, x in enumerate(items) if x["ttl"] == "SESSION"]
                items.pop(min(sess or range(len(items)), key=lambda i: items[i]["created_seg"]))
        elif op["op"] == "T-UPDATE":
            it = next(x for x in items if x["id"] == op["item"])
            it["text"] = " | ".join((it["text"].split(" | ") + [by_unit[op["unit"]]["value"]])[-2:])[:280]
        elif op["op"] in ("T-EXPIRE", "PROMOTE"):
            items = [x for x in items if x["id"] != op["item"]]
    if nxt is None:
        return items
    out = []
    for it in items:
        if nxt["session_id"] != seg["session_id"] and it["ttl"] == "SESSION":
            continue
        if it["ttl"] == "UNTIL" and it["until"] is not None and nxt["at"] > it["until"]:
            continue
        if nxt["at"] - it["created_at"] > 14 * DAY:
            continue
        out.append(it)
    return out


def check_episode(ep):
    errs = []
    segs = ep["segments"]
    for i, seg in enumerate(segs):
        tx = seg["text"]
        where = f"{ep['id']} seg {i}"
        spans = []
        for u in seg["units"]:
            a, b = u["char_span"]
            if not (0 <= a < b <= len(tx)) or tx[a:b] != u["text"]:
                errs.append(f"V1 {where}: unit span {u['char_span']} != {u['text']!r}")
            if u["route"] != "FORGET" and u.get("src") is None and u["text"] != u["value"] and u["text"].lower() != str(u["value"]).lower():
                errs.append(f"V1 {where}: exact unit text {u['text']!r} != value {u['value']!r}")
            spans.append((a, b))
        spans.sort()
        if any(spans[k][1] > spans[k + 1][0] for k in range(len(spans) - 1)):
            errs.append(f"V1 {where}: overlapping unit spans")
        for m in seg["mentions"]:
            a, b = m["char_span"]
            if not (0 <= a < b <= len(tx)) or tx[a:b] != m["text"]:
                errs.append(f"V1 {where}: mention span mismatch")
        store = {r["id"]: r for r in seg["store_before"]}
        profiles = {r["entity"] for r in seg["store_before"]} | {"user"}
        temp = {t["id"]: t for t in seg["temp_before"]}
        for u in seg["units"]:
            tg = u.get("target")
            if u["route"] == "IGNORE" and u["cert"] not in ("joking", "hypothetical", "quoting"):
                errs.append(f"V5 {where}: IGNORE unit with certainty {u['cert']}")
            if u["route"] == "PERSIST" and u["cert"] not in ("stated", "implied"):
                errs.append(f"V5 {where}: PERSIST unit with certainty {u['cert']}")
            if u["route"] == "TEMP" and (u.get("ttype") is None or u.get("ttl") is None or u.get("tmp") is None):
                errs.append(f"V5 {where}: TEMP unit without type/ttl/target")
            if u.get("rel") is not None and (not tg or tg["type"] != "record"):
                errs.append(f"V5 {where}: relation on a non-record target")
            if tg and tg["type"] == "record" and tg["fact"] not in store:
                errs.append(f"V4 {where}: record target {tg['fact']} not in store_before")
            if tg and tg["type"] == "new_attr" and tg["entity"] not in profiles:
                errs.append(f"V4 {where}: NEW-ATTR profile {tg['entity']} not in store")
            if tg and tg["type"] == "new_ent" and tg["entity"] in profiles:
                errs.append(f"V4 {where}: NEW-ENT entity {tg['entity']} already has records")
            if u.get("src"):
                if u["src"] not in temp or temp[u["src"]]["type"] != "PENDING":
                    errs.append(f"V4 {where}: PROMOTE source {u['src']} is not a PENDING item")
            if u["route"] == "TEMP" and u.get("tmp") not in ("NEW", None) and u["tmp"] not in temp:
                errs.append(f"V4 {where}: temp target {u['tmp']} not in temp_before")
            if O.INDEX.get(u["attr"]) is None and u["attr"] != "OTHER":
                errs.append(f"V5 {where}: unknown attribute {u['attr']}")
        units = {u["tag"]: u for u in seg["units"]}
        for mg in seg["merges"]:
            lic = units.get(mg["licensed_by"])
            ents = {store[f]["entity"] for f in mg["facts"] if f in store}
            if not lic or lic["route"] != "PERSIST" or lic["entity"] not in ents:
                errs.append(f"V6 {where}: merge not licensed by a PERSIST unit on the pair's profiles")
        nxt = segs[i + 1] if i + 1 < len(segs) else None
        if nxt is not None:
            if not same_store(nxt["store_before"], replay_store(seg, seg["store_before"])):
                errs.append(f"V2 {where}: replayed store differs from the next store_before")
            want = replay_temp(seg, seg["temp_before"], nxt)
            got = nxt["temp_before"]
            key = lambda t: (t["id"], t["type"], t["ttl"], t["text"])
            if sorted(map(key, want)) != sorted(map(key, got)):
                errs.append(f"V3 {where}: replayed temporary state differs from the next temp_before")
    return errs


def leakage(files):
    by_split = collections.defaultdict(list)
    for f in files:
        for line in open(f):
            ep = json.loads(line)
            by_split[ep["split"]].append(ep)
    out = {}
    test_only = O.test_only_values()
    for sp, eps in by_split.items():
        if sp in ("train", "val", "pilot"):
            n = sum(1 for ep in eps for s in ep["segments"] for u in s["units"] if (u["attr"], u["value"]) in test_only)
            n += sum(1 for ep in eps for s in ep["segments"] for r in s["store_before"] if (r["attribute"], r["value"]) in test_only)
            out[f"L1 test-only values in {sp}"] = n
            out[f"L3 family-C templates in {sp}"] = sum(s.get("families", []).count("C") for ep in eps for s in ep["segments"])
    names = {sp: {v["name"] for ep in eps for v in ep["world"].values() if v.get("name")} for sp, eps in by_split.items()}
    sps = sorted(names)
    for i, a in enumerate(sps):
        for b in sps[i + 1:]:
            if {a, b} <= {"train", "pilot"} or {a, b} <= {"test", "stress"}:
                continue
            out[f"L2 names shared {a}/{b}"] = len(names[a] & names[b])
    turns = {sp: {t["text"].lower() for ep in eps for s in ep["segments"] for t in s["turns"] if t["speaker"] == "user" and s["units"]}
             for sp, eps in by_split.items()}
    for i, a in enumerate(sps):
        for b in sps[i + 1:]:
            if {a, b} <= {"train", "pilot"} or {a, b} <= {"test", "stress"}:
                continue
            out[f"L4 identical user turns with units {a}/{b}"] = len(turns[a] & turns[b])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    total, bad, errs = 0, 0, collections.Counter()
    examples = {}
    for f in a.files:
        for line in open(f):
            ep = json.loads(line)
            total += 1
            e = check_episode(ep)
            if e:
                bad += 1
            for x in e:
                errs[x.split(" ")[0]] += 1
                examples.setdefault(x.split(" ")[0], x)
    print(json.dumps({"episodes": total, "episodes_with_errors": bad, "errors_by_check": dict(errs), "first_example": examples,
                      "leakage": leakage(a.files)}, indent=1))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
