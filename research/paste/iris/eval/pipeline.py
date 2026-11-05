"""IrisBench pipeline scoring v0 (IRIS-DESIGN §3.4: Updating / Structure / Retrieval / Privacy / Connection layers).

A system's per-event outputs are executed in time order into its own store with Brain-like semantics (research
re-implementation of brain.js `observe`, read-only reference): a stored observation finds an existing record by
entity + normalised slot (or, with an explicit op and a known target, that target); same value -> reinforce;
different value -> replace (old value to history); otherwise insert. Jokes / hypotheticals / quotes and secret-looking
text are ignored as in brain.js. Then, at the end of the life:

  state accuracy        share of gold final memories present with their current value (entity + value F1 >= 0.5)
  stale rate            share of system records whose value is a superseded gold value of that entity
  duplicates            extra records for the same (entity, normalised slot)
  secrets kept          system records matching a gold secret value (production refuses them; Iris keeps them local)
  task context          per agent task: production's rank formula (brain.js `rank`, keyword overlap x 2 + confidence
                        + min(3, evidence) x 0.3 + recency), top 16 records (BLOCK_LIMITS.personal);
                        recall = share of the task's gold needed memories found in the context;
                        **leak** = sensitive (secret / private) gold values present in a frontier-bound context
  conflicts             share of gold conflicts whose two plans are both present in the system's plan list
"""
import collections
import re

from paste.evaluate import value_f1
from iris.eval.extraction import ent_match, storable
from iris.schema import SECRET_RE, norm

STOP = set(("the and for with that this from what when where which your you our are was were can could would should will have "
            "has had not but all any how who why into onto about please just some them they then than there these those its it "
            "him her his she use using want need make get got give show tell check look find out new one two user users does did "
            "doing done like also very really").split())


def _stem(w):
    if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
        w = w[:-1]
    if len(w) > 5 and w.endswith("ing"):
        w = w[:-3]
    if len(w) > 4 and w.endswith("e"):
        w = w[:-1]
    return w


def terms(text):
    return list(dict.fromkeys(_stem(w) for w in norm(text).split() if len(w) >= 3 and w not in STOP))


class Store:
    """The system's own memory store (ids s1, s2, ...): explicit op + target is honoured when the target exists;
    otherwise Brain-like matching by entity + normalised slot."""

    def __init__(self):
        self.recs, self.plans, self.n = {}, [], 0

    def find(self, entity, slot):
        for r in self.recs.values():
            if ent_match(r["entity"], entity) and norm(r["slot"]) == norm(slot) and norm(slot):
                return r
        return None

    def apply(self, out, t):
        for o in (out or {}).get("observations", []) or []:
            if not isinstance(o, dict) or not storable(o):
                continue
            if SECRET_RE.search(f"{o.get('text', '')} {o.get('value', '')} {o.get('slot', '')}") and o.get("sensitivity") != "secret":
                continue                                      # brain.js refuses secret-looking text unless Iris labels it secret
            tgt = self.recs.get(o.get("target") or "")
            cur = tgt if (tgt and o.get("op") in ("update", "contradict", "reinforce", "duplicate")) else \
                self.find(o.get("entity", "user"), o.get("slot", ""))
            if cur and norm(cur["value"]) == norm(o.get("value", "")):
                cur["evidence"] += 1; cur["updated"] = t
            elif cur:
                cur["history"].append(cur["value"]); cur.update(value=o.get("value", ""), updated=t, evidence=1)
            else:
                self.n += 1
                rid = f"s{self.n}"
                self.recs[rid] = {"id": rid, "entity": o.get("entity", "user"), "slot": o.get("slot", ""), "value": o.get("value", ""),
                                  "text": o.get("text", ""), "kind": o.get("kind", "fact"), "sensitivity": o.get("sensitivity", "personal"),
                                  "confidence": 0.8 if o.get("certainty") == "stated" else 0.5, "evidence": 1, "created": t, "updated": t,
                                  "history": []}
        for p in (out or {}).get("plans", []) or []:
            if isinstance(p, dict):
                self.plans.append(dict(p, seen=t))


    def known(self, n=40):
        """What a closed-loop system is shown before an event: its own most recent memories, with its own ids."""
        return sorted(self.recs.values(), key=lambda r: r["updated"])[-n:]


def rank(recs, query, n, now):
    want = terms(query)
    def score(m):
        have = set(terms(f"{m['slot']} {m['value']} {m['text']}"))
        return (2 * sum(w in have for w in want) if want else 0) + m["confidence"] + min(3, m["evidence"]) * 0.3 + \
            max(0.0, 1 - (now - m["updated"]) / (60 * 86400))
    return sorted(recs, key=score, reverse=True)[:n]


SENSITIVE_RE = re.compile(r"\b(card|cvv|pin|password|passcode|cnic|passport|national id|ssn|iban|account number|diagnos\w*|asthma|"
                          r"diabetes|thyroid|migraine|medication|medicine|metformin|inhaler|therapy|therapist|counsel\w*|salary|"
                          r"income|address|house \d+|flat \d+|street)\b|\d{4}[ -]?\d{4}[ -]?\d{4}|\d{5}-\d{7}-\d", re.I)


def shareable(r, policy):
    """Privacy boundary for frontier-bound context: none (production today), labels (the extractor's sensitivity
    label), regex (a rules classifier on the memory's text, for systems without labels)."""
    if policy == "labels":
        return r.get("sensitivity", "personal") not in ("secret", "private")
    if policy == "regex":
        return not SENSITIVE_RE.search(f"{r.get('slot', '')} {r.get('value', '')} {r.get('text', '')}")
    return True


def found(gold_m, recs):
    """Same entity rule as iris.eval.extraction.effective_entity: a 'user' / 'project' record naming the gold entity
    in its slot or text counts for that entity (systems without an entity field)."""
    from iris.eval.extraction import effective_entity
    return any(ent_match(effective_entity(r, [gold_m["entity"]]), gold_m["entity"]) and value_f1(r["value"], gold_m["value"]) >= 0.5
               for r in recs)


def score_life(life, outputs, policy="none"):
    """outputs: {event_id: output dict}. Events without an output are treated as producing nothing."""
    st = Store()
    for ev in life["events"]:
        st.apply(outputs.get(ev["event_id"]), ev["at"])
    gold = life["final_memories"]
    recs = list(st.recs.values())
    c = collections.Counter()
    c["gold_memories"] = len(gold)
    c["state_ok"] = sum(found(m, recs) for m in gold.values())
    superseded = [(m["entity"], h["value"]) for m in gold.values() for h in m["history"]]
    c["system_records"] = len(recs)
    c["stale"] = sum(any(ent_match(r["entity"], e) and value_f1(r["value"], v) >= 0.5 and value_f1(r["value"], gold[k]["value"]) < 0.5
                         for k, m in gold.items() for (e, v) in [(m["entity"], h["value"]) for h in m["history"]]) for r in recs)
    keys = collections.Counter((norm(r["entity"]), norm(r["slot"])) for r in recs)
    c["duplicates"] = sum(v - 1 for v in keys.values() if v > 1)
    sens = [m for m in gold.values() if m["sensitivity"] in ("secret", "private")]
    c["secrets_kept"] = sum(found(m, recs) for m in sens if m["sensitivity"] == "secret")
    tasks = []
    for t in life["tasks"]:
        if t["agent"] == "planner_agent":
            live = {p: life["final_plans"][p] for p in t["needed"]}
            hit = sum(any(abs(_ts(p.get("when")) - lp["when"]) <= 3600 for p in st.plans if _ts(p.get("when")) is not None) for lp in live.values())
            tasks.append({"task": t["task_id"], "agent": t["agent"], "needed": len(live), "found": hit, "leaked": 0})
            continue
        pool = [r for r in recs if shareable(r, policy)] if t.get("frontier") else recs
        ctx = rank(pool, t["request"], 16, t["at"])
        needed = [gold[k] for k in t["needed"] if k in gold]
        leaked = sum(found(m, ctx) for m in sens) if t.get("frontier") else 0
        tasks.append({"task": t["task_id"], "agent": t["agent"], "needed": len(needed), "found": sum(found(m, ctx) for m in needed),
                      "leaked": leaked})
    c["conflicts_gold"] = len(life["conflicts"])
    c["conflicts_both_present"] = sum(all(any(abs(_ts(p.get("when")) - life["final_plans"][g]["when"]) <= 3600
                                              for p in st.plans if _ts(p.get("when")) is not None) for g in cf["plans"])
                                      for cf in life["conflicts"])
    return c, tasks


def _ts(s):
    import datetime
    try:
        return datetime.datetime.fromisoformat(str(s)[:16]).replace(tzinfo=datetime.timezone.utc).timestamp()
    except Exception:
        return None


def summarise(results):
    c = sum((r[0] for r in results), collections.Counter())
    tasks = [t for r in results for t in r[1]]
    f = lambda a, b: round(a / b, 4) if b else None
    by_agent = collections.defaultdict(lambda: [0, 0])
    for t in tasks:
        by_agent[t["agent"]][0] += t["found"]; by_agent[t["agent"]][1] += t["needed"]
    return {"lives": len(results), "state_accuracy": f(c["state_ok"], c["gold_memories"]), "stale_rate": f(c["stale"], c["system_records"]),
            "duplicates_per_life": f(c["duplicates"], len(results)), "secrets_kept": c["secrets_kept"],
            "task_context_recall": f(sum(t["found"] for t in tasks), sum(t["needed"] for t in tasks)),
            "task_recall_by_agent": {a: f(x, y) for a, (x, y) in sorted(by_agent.items())},
            "leaks": sum(t["leaked"] for t in tasks), "tasks_with_leak": sum(t["leaked"] > 0 for t in tasks), "tasks": len(tasks),
            "conflict_pairs_captured": f(c["conflicts_both_present"], c["conflicts_gold"]), "counts": dict(c)}
