"""IrisBench extraction scoring v0 (IRIS-DESIGN §3.4, layers Extraction / Typing / Updating-op / Privacy-label / Plans).

Per event, a system's output ({observations, plans, relations} in the iris.schema contract) is compared with the
event's gold. Storable gold = ops new / reinforce / update / contradict (stated or implied); gold with op "none"
(jokes, hypotheticals, quotes) must not become memories.

Matching (greedy, best first): same entity (user synonyms; a person by full name or first name) and value token F1
>= 0.5. Then, on matched pairs: slot agreement (normalised equal or >= 50 % of the gold slot's tokens), kind,
certainty, op and sensitivity accuracy.
  false memory          predicted storable observation with no storable gold match (share of predictions = the
                        production release-gate measure)
  misattribution        a false memory whose value matches a storable gold value of another entity
  stored non-storable   a false memory whose value matches a gold op-"none" observation
Plans: matched by time (within 60 minutes) and at least one shared content word; status accuracy.

    python -m iris.eval.extraction --lives lives.jsonl --pred pred.jsonl --out score.json
pred.jsonl lines: {life_id, event_id, output: {observations, plans, relations}}
"""
import argparse
import collections
import datetime
import json
import re

from paste.evaluate import value_f1
from iris.schema import norm

USER = {"user", "me", "the user", "i", "myself"}
STORE_OPS = ("new", "reinforce", "update", "contradict")


def ent_key(e):
    e = norm(e)
    return "user" if e in USER else e


def ent_match(a, b):
    a, b = ent_key(a), ent_key(b)
    if a == b:
        return True
    if "user" in (a, b):
        return False
    return a.split()[0] == b.split()[0] if a and b else False


def slot_ok(pred, gold):
    p, g = set(norm(pred).split()), set(norm(gold).split())
    return norm(pred) == norm(gold) or (g and len(p & g) / len(g) >= 0.5)


def storable(o):
    return o.get("certainty", "stated") in ("stated", "implied") and o.get("op", "new") != "none"


def _ts(s):
    try:
        return datetime.datetime.fromisoformat(str(s)[:16]).timestamp()
    except Exception:
        return None


def score_event(gold_ev, out):
    g = gold_ev["gold"]
    gs = [o for o in g["observations"] if o["op"] in STORE_OPS]
    gn = [o for o in g["observations"] if o["op"] == "none"]
    ps = [o for o in (out or {}).get("observations", []) if isinstance(o, dict) and storable(o)]
    c = collections.Counter()
    cand = sorted(((value_f1(p.get("value", ""), q["value"]), i, j) for i, p in enumerate(ps) for j, q in enumerate(gs)
                   if ent_match(p.get("entity", "user"), q["entity"]) and value_f1(p.get("value", ""), q["value"]) >= 0.5), reverse=True)
    used_p, used_g = set(), set()
    for _, i, j in cand:
        if i in used_p or j in used_g:
            continue
        used_p.add(i); used_g.add(j)
        p, q = ps[i], gs[j]
        c["tp"] += 1
        c["slot_ok"] += bool(slot_ok(p.get("slot", ""), q["slot"]))
        c["kind_ok"] += p.get("kind") == q["kind"]
        c["cert_ok"] += p.get("certainty") == q["certainty"]
        c["op_ok"] += p.get("op") == q["op"]
        c["sens_ok"] += p.get("sensitivity") == q["sensitivity"]
        c[f"op_gold_{q['op']}"] += 1
        c[f"op_hit_{q['op']}"] += p.get("op") == q["op"]
    for i, p in enumerate(ps):
        if i in used_p:
            continue
        c["fp"] += 1
        v = p.get("value", "")
        if any(value_f1(v, q["value"]) >= 0.5 for q in gs):
            c["misattributed"] += 1
        elif any(value_f1(v, q["value"]) >= 0.5 for q in gn):
            c["stored_nonstorable"] += 1
    c["fn"] = len(gs) - len(used_g)
    c["gold_nonstorable"] = len(gn)
    c["pred"] = len(ps)
    # plans
    gp = g["plans"]
    pp = [x for x in (out or {}).get("plans", []) if isinstance(x, dict)]
    used = set()
    for x in pp:
        tx = _ts(x.get("when"))
        best = None
        for j, y in enumerate(gp):
            if j in used:
                continue
            ty = _ts(y["when"])
            words = set(norm(x.get("what", "")).split()) & set(norm(y["what"]).split()) - {"the", "a"}
            if tx is not None and ty is not None and abs(tx - ty) <= 3600 and (words or not norm(x.get("what", ""))):
                best = j; break
        if best is None:
            c["plan_fp"] += 1
        else:
            used.add(best); c["plan_tp"] += 1
            c["plan_status_ok"] += x.get("status") == gp[best]["status"]
    c["plan_fn"] = len(gp) - len(used)
    return c


def summarise(counts, n_events):
    c = sum(counts, collections.Counter())
    f = lambda a, b: round(a / b, 4) if b else None
    tp, fp, fn = c["tp"], c["fp"], c["fn"]
    out = {"events": n_events, "precision": f(tp, tp + fp), "recall": f(tp, tp + fn), "f1": f(2 * tp, 2 * tp + fp + fn),
           "false_memory_share": f(fp, tp + fp), "false_memories_per_100_events": f(100 * fp, n_events),
           "misattributed": c["misattributed"], "stored_nonstorable": c["stored_nonstorable"],
           "gold_nonstorable": c["gold_nonstorable"],
           "on_matched": {k: f(c[f"{k}_ok"], tp) for k in ("slot", "kind", "cert", "op", "sens")},
           "op_recall_by_gold_op": {o: f(c[f"op_hit_{o}"], c[f"op_gold_{o}"]) for o in STORE_OPS},
           "plans": {"precision": f(c["plan_tp"], c["plan_tp"] + c["plan_fp"]), "recall": f(c["plan_tp"], c["plan_tp"] + c["plan_fn"]),
                     "status_acc_on_matched": f(c["plan_status_ok"], c["plan_tp"])},
           "counts": dict(c)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lives", required=True)
    ap.add_argument("--pred", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    pred = {(r["life_id"], r["event_id"]): r.get("output") for r in map(json.loads, open(a.pred))}
    counts, by_src = [], collections.defaultdict(list)
    for line in open(a.lives):
        life = json.loads(line)
        for ev in life["events"]:
            k = (life["life_id"], ev["event_id"])
            if k not in pred:
                continue
            c = score_event(ev, pred[k])
            counts.append(c); by_src[ev["source"]].append(c)
    rep = {"all": summarise(counts, len(counts)), "by_source": {s: summarise(v, len(v)) for s, v in sorted(by_src.items())}}
    json.dump(rep, open(a.out, "w"), indent=1)
    print(json.dumps(rep["all"], indent=1))


if __name__ == "__main__":
    main()
