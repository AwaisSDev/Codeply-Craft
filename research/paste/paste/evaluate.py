"""Closed-loop evaluation (EVALUATION-PROTOCOL.md §1-§4).

A system is a function propose(seg, rows, temp_state) -> (operations, new_temp_state). Each episode is replayed
segment by segment: the system's operations are executed by paste.brain_sim, so it reads the store it built itself.
Gold operations are re-expressed against that store through record provenance (closed-loop gold):
  * a gold operation on fact f targets the system's record with provenance f;
  * if the system never wrote f, the expected operation becomes a WRITE of the same entity/attribute/value.
Matching (§3): WRITE on entity + attribute + value (token-F1 >= 0.5); UPDATE on target + value; MERGE_INTO, FORGET
on target; FORGET_PROFILE on profile; MERGE on the unordered pair. Per-episode counts are kept for the bootstrap.

    python -m paste.evaluate --system oracle --data <episodes.jsonl>        (sanity: PE must be 1.0)
"""
import argparse
import collections
import copy
import json
import re
import sys

from .brain_sim import BrainSim

WORD = re.compile(r"[a-z0-9]+")
OPS = ("WRITE", "UPDATE", "MERGE_INTO", "FORGET", "FORGET_PROFILE", "MERGE")


def norm_tokens(s):
    return WORD.findall(str(s).lower())


def value_f1(a, b):
    ta, tb = norm_tokens(a), norm_tokens(b)
    if not ta or not tb:
        return float(ta == tb)
    common = sum((collections.Counter(ta) & collections.Counter(tb)).values())
    if not common:
        return 0.0
    p, r = common / len(ta), common / len(tb)
    return 2 * p * r / (p + r)


class Replay:
    """One episode's closed-loop state: the system's store (with provenance) and entity aliases."""

    def __init__(self, ep):
        self.ep = ep
        self.sim = BrainSim(capacity=10_000)
        for r in ep["segments"][0]["store_before"]:
            self.sim.records[r["id"]] = copy.deepcopy(r)
        self.sim.t = max([r["updated"] for r in self.sim.records.values()] + [0])
        self.alias = {}                  # system entity key -> gold entity key (for new profiles the system created)
        self.n_new = 0

    def rows(self):
        return [{"id": r["id"], "entity": r["entity"], "profile_text": r.get("profile_text") or r["entity"],
                 "attribute": r["attribute"], "value": r["value"], "kind": r.get("kind"), "status": r["status"],
                 "evidence": r["evidence"], "locked": r.get("locked", False)} for r in self.sim.records.values()]

    def has_entity(self, gold_key):
        """True when the system's store has a profile for this gold entity (the user always exists)."""
        return gold_key == "user" or any(self.gold_entity(r["entity"]) == gold_key for r in self.sim.records.values())

    def gold_entity(self, sys_key):
        return self.alias.get(sys_key, sys_key)

    def by_provenance(self, fact):
        for r in self.sim.records.values():
            if r.get("provenance") == fact:
                return r
        return None

    def closed_loop_gold(self, seg):
        """Gold operations of this segment, expressed against the system's current store."""
        out = []
        for g in seg["gold_ops"]:
            op = g["op"]
            if op in ("UPDATE", "MERGE_INTO", "FORGET"):
                rec = self.by_provenance(g["fact"])
                if rec is not None:
                    out.append({**g, "target": rec["id"]})
                elif op != "FORGET":                    # never written by the system: the expected action is a WRITE
                    orig = next((r for r in seg["store_before"] if r["id"] == g["fact"]), None)
                    if orig is not None:
                        out.append({"op": "WRITE", "entity": orig["entity"], "attribute": orig["attribute"], "value": g["value"],
                                    "fact": g["fact"], "recovered": True, "unit": g.get("unit")})
            elif op == "MERGE":
                recs = [self.by_provenance(f) for f in g["facts"]]
                if all(recs):
                    out.append({**g, "targets": frozenset(r["id"] for r in recs)})
            else:
                out.append(dict(g))
        return out


def match_segment(rep, seg, preds, gold):
    """Greedy matching by confidence. Returns per-type TP/FP/FN, the matched gold for each matched prediction,
    and the unmatched predicted WRITEs (false permanent memories)."""
    units = {u["tag"]: u for u in seg["units"]}
    ment_text = {m["tag"]: m["text"] for m in seg["mentions"]}
    used = set()
    tp, fp, fn = collections.Counter(), collections.Counter(), collections.Counter()
    false_writes, pairs = [], []

    def ok(p, g):
        if p["op"] != g["op"]:
            return False
        if p["op"] == "WRITE":
            if p.get("new_entity"):
                gu = units.get(g.get("unit"))
                gm = ment_text.get(f"m{gu['mention']}") if gu and gu.get("mention") is not None else None
                # NEW-ENT is correct when gold is a new entity, or when the system's own store has no profile for the
                # gold entity (it missed the earlier write that created it): protocol §3, "NEW-ENT with the mention
                # resolving to the gold entity". Before 2026-11-03 the second case could never match (DECISIONS).
                g_new = g.get("new_entity") or not rep.has_entity(g["entity"])
                if not g_new or gm is None or not (set(norm_tokens(p.get("mention") or "")) & set(norm_tokens(gm))):
                    return False
            elif rep.gold_entity(p["entity"]) != g["entity"]:
                return False
            return p["payload"]["attribute"] == g["attribute"] and value_f1(p["payload"]["value"], g["value"]) >= 0.5
        if p["op"] == "UPDATE":
            return p["target"] == g["target"] and value_f1(p["payload"]["value"], g["value"]) >= 0.5
        if p["op"] in ("MERGE_INTO", "FORGET"):
            return p["target"] == g["target"]
        if p["op"] == "FORGET_PROFILE":
            return rep.gold_entity(p["entity"]) == g["entity"]
        if p["op"] == "MERGE":
            return frozenset((p["target"], p["with"])) == g["targets"]
        return False

    for p in sorted(preds, key=lambda x: -x.get("confidence", 0.0)):
        hit = next((i for i, g in enumerate(gold) if i not in used and ok(p, g)), None)
        if hit is None:
            fp[p["op"]] += 1
            if p["op"] == "WRITE":
                false_writes.append(p)
        else:
            used.add(hit); tp[p["op"]] += 1; pairs.append((p, gold[hit]))
    for i, g in enumerate(gold):
        if i not in used:
            fn[g["op"]] += 1
    return tp, fp, fn, false_writes, pairs


def execute(rep, ops, pairs):
    """Execute the system's operations in its own Brain; provenance = matched gold fact (or spurious)."""
    prov = {id(p): g.get("fact", "spurious") for p, g in pairs}
    for p in ops:
        op = dict(p)
        if op["op"] == "WRITE":
            if op.get("new_entity"):
                rep.n_new += 1
                key = f"new{rep.n_new}:{op.get('mention') or 'unknown'}"
                g = next((g for q, g in pairs if q is p), None)
                if g is not None:
                    rep.alias[key] = g["entity"]
                op["entity"], op["profile_text"] = key, op.get("mention") or "someone"
            else:
                op["profile_text"] = next((r.get("profile_text") for r in rep.sim.records.values() if r["entity"] == op["entity"]), op["entity"])
            res = rep.sim.add(op["entity"], op["profile_text"], op["payload"], provenance=prov.get(id(p), "spurious"))
        else:
            rep.sim.apply(op)


def evaluate(episodes, propose, init_state=None):
    """Closed-loop replay of every episode. Returns totals and per-episode counts (for the paired bootstrap)."""
    per_ep = []
    for ep in episodes:
        rep = Replay(ep)
        state = init_state
        c = {"tp": collections.Counter(), "fp": collections.Counter(), "fn": collections.Counter(), "segments": 0,
             "false_writes": 0, "false_write_routes": collections.Counter()}
        for seg in ep["segments"]:
            gold = rep.closed_loop_gold(seg)
            ops, state = propose(rep, seg, rep.rows(), state)
            tp, fp, fn, fw, pairs = match_segment(rep, seg, ops, gold)
            for k in OPS:
                c["tp"][k] += tp[k]; c["fp"][k] += fp[k]; c["fn"][k] += fn[k]
            c["segments"] += 1
            c["false_writes"] += len(fw)
            for p in fw:                      # which gold route the false memory came from (H3 leak-rate)
                span = p.get("evidence", {}).get("span")
                route = "none"
                for u in seg["units"]:
                    if span and u.get("text") and u["text"] in p.get("evidence", {}).get("text", ""):
                        route = u["route"]; break
                c["false_write_routes"][route] += 1
            execute(rep, ops, pairs)
        per_ep.append({"id": ep["id"], **{k: (dict(v) if isinstance(v, collections.Counter) else v) for k, v in c.items()}})
    return summarise(per_ep), per_ep


def summarise(per_ep):
    tp = sum((collections.Counter(e["tp"]) for e in per_ep), collections.Counter())
    fp = sum((collections.Counter(e["fp"]) for e in per_ep), collections.Counter())
    fn = sum((collections.Counter(e["fn"]) for e in per_ep), collections.Counter())
    T, P, N = sum(tp.values()), sum(fp.values()), sum(fn.values())
    segs = sum(e["segments"] for e in per_ep)
    f1 = lambda t, p, n: round(2 * t / (2 * t + p + n), 4) if t + p + n else None
    return {"PE": f1(T, P, N), "precision": round(T / (T + P), 4) if T + P else None, "recall": round(T / (T + N), 4) if T + N else None,
            "FPM_per_100_segments": round(100 * sum(e["false_writes"] for e in per_ep) / max(1, segs), 3),
            "per_op": {k: {"tp": tp[k], "fp": fp[k], "fn": fn[k], "f1": f1(tp[k], fp[k], fn[k])} for k in OPS},
            "merge_PR": {"precision": round(tp["MERGE"] / (tp["MERGE"] + fp["MERGE"]), 4) if tp["MERGE"] + fp["MERGE"] else None,
                         "recall": round(tp["MERGE"] / (tp["MERGE"] + fn["MERGE"]), 4) if tp["MERGE"] + fn["MERGE"] else None},
            "episodes": len(per_ep), "segments": segs}


# ---- systems ------------------------------------------------------------------------------------
def oracle_propose(rep, seg, rows, state):
    """Proposes exactly the closed-loop gold (sanity check of the evaluator)."""
    ops = []
    for g in rep.closed_loop_gold(seg):
        payload = {"attribute": g.get("attribute"), "value": g.get("value"), "certainty": g.get("certainty", "stated"),
                   "kind": g.get("kind", "fact")}
        if g["op"] == "WRITE":
            gu = next((u for u in seg["units"] if u["tag"] == g.get("unit")), None)
            new = bool(g.get("new_entity"))
            ment = next((m["text"] for m in seg["mentions"] if gu and gu.get("mention") is not None and m["tag"] == f"m{gu['mention']}"), None)
            sys_key = next((k for k, v in rep.alias.items() if v == g["entity"]), g["entity"])
            known = any(r["entity"] == sys_key for r in rep.sim.records.values()) or g["entity"] == "user"
            ops.append({"op": "WRITE", "entity": sys_key, "new_entity": new and not known, "mention": ment, "payload": payload, "confidence": 1.0})
        elif g["op"] in ("UPDATE", "MERGE_INTO", "FORGET"):
            ops.append({"op": g["op"], "target": g["target"], "payload": payload, "challenge": g.get("subtype") == "CONTRADICTION", "confidence": 1.0})
        elif g["op"] == "FORGET_PROFILE":
            sys_key = next((k for k, v in rep.alias.items() if v == g["entity"]), g["entity"])
            ops.append({"op": "FORGET_PROFILE", "entity": sys_key, "confidence": 1.0})
        elif g["op"] == "MERGE":
            a, b = sorted(g["targets"])
            ops.append({"op": "MERGE", "target": a, "with": b, "confidence": 1.0})
    return ops, state


def model_propose(adapter):
    def propose(rep, seg, rows, state):
        out = adapter.step({"turns": seg["turns"], "at": seg["at"], "session_id": seg["session_id"]}, rows, state)
        return out["operations"], out["temp_state"]
    return propose


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--system", default="oracle")
    ap.add_argument("--data", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--final", action="store_true", help="required for frozen test/stress files (protocol §2)")
    a = ap.parse_args()
    if ("frozen" in a.data or "test-" in a.data or "stress-" in a.data) and not a.final:
        sys.exit("frozen data: only evaluate.py --final may read it (EVALUATION-PROTOCOL §2)")
    if a.final:
        sys.exit("--final runs require results/final/FROZEN-RUNS.json entries (not implemented until systems are frozen)")
    eps = [json.loads(l) for l in open(a.data)]
    eps = eps[:a.limit] if a.limit else eps
    if a.system != "oracle":
        sys.exit("model systems are evaluated through paste.train / scripts that build the model")
    summary, _ = evaluate(eps, oracle_propose)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
