"""Reference deterministic store for Iris operations, and the gold-operation derivation.

`MemoryStore` is what "infrastructure" means in the Iris design: it owns ids, history, sources, expiry and
deletion. Iris only proposes; the store applies ops that passed `contract.guard`. It mirrors the production
Brain's outcomes (insert / replace / reinforce / forget / challenge) and keeps every superseded value in
`history`, so nothing is silently lost. Production integration replaces this class with the Brain; the research
pipeline (closed-loop evaluation, self-output training data) uses it directly.

`derive_ops` turns teacher labels (facts keyed by slot) into the exact operations that are correct against a
given store state. Because the derivation is a function of the store, the same labelled session yields correct
targets for a gold store, an empty store, or a store full of the model's own earlier mistakes.
"""
import copy

from .contract import norm, squash


def tokens(s):
    return [t for t in norm(s).split() if t not in STOP]


STOP = frozenset("the a an of to in on at for and or is are was be it its this that with by from as".split())


def value_sim(a, b):
    """Token-F1 of two values after normalisation (0..1)."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 1.0 if norm(a) == norm(b) else 0.0
    common = 0
    rest = list(tb)
    for t in ta:
        if t in rest:
            rest.remove(t)
            common += 1
    if not common:
        return 0.0
    p, r = common / len(ta), common / len(tb)
    return 2 * p * r / (p + r)


def same_value(a, b, when_a=None, when_b=None):
    """Two values are the same fact when they (nearly) coincide and their dates do not disagree."""
    if when_a and when_b and not (when_a.startswith(when_b) or when_b.startswith(when_a)):
        return False
    if norm(a) == norm(b):
        return True
    digits = lambda s: sorted(t for t in norm(s).split() if any(ch.isdigit() for ch in t))
    return digits(a) == digits(b) and value_sim(a, b) >= 0.6


class MemoryStore:
    """In-memory reference store. Records are plain dicts:

    id, ent, type, attr, val, kind, when, until, keep, basis, conf, sens, rel, status (live | retracted),
    challenged (list of conflicting claims), evidence (count), sources [{session, src, evid}],
    history [{val, when, until, session, why}], created, updated, key (evaluation-only provenance, never shown).
    """

    def __init__(self):
        self.rows = {}
        self._n = 0
        self.log = []                       # append-only audit trail of applied ops

    def _new_id(self):
        self._n += 1
        return f"m{self._n}"

    def insert(self, rec, session=None):
        """Low-level insert of a record dict (used for seeding and by `apply`)."""
        mid = rec.get("id") or self._new_id()
        row = {"id": mid, "status": "live", "challenged": [], "evidence": 1, "sources": [], "history": [],
               "created": session, "updated": session, "key": None}
        row.update({k: v for k, v in rec.items() if v not in (None, "", [])})
        row["id"] = mid
        self.rows[mid] = row
        return row

    def live(self, today=None):
        """Memories visible to the model: not retracted, and temp items not past `until`."""
        out = []
        for r in self.rows.values():
            if r["status"] != "live":
                continue
            if today and r.get("keep") == "temp" and r.get("until") and r["until"] < today:
                continue
            out.append(r)
        return out

    def apply(self, op, session=None, key=None):
        """Apply one guarded op. Returns the affected row (or None for skip). `key` is evaluation provenance."""
        kind = op["op"]
        src = {"session": session, "src": op.get("src"), "evid": op.get("evid")}
        self.log.append({"session": session, "op": copy.deepcopy(op)})
        if kind == "skip":
            return None
        if kind == "add":
            rec = {k: op[k] for k in ("ent", "type", "attr", "val", "kind", "when", "until", "keep", "basis", "conf",
                                      "sens", "rel") if k in op}
            row = self.insert(rec, session)
            row["sources"].append(src)
            row["key"] = key
            return row
        row = self.rows.get(op["ref"])
        if row is None:
            return None
        if kind == "confirm":
            row["evidence"] += 1
            row["sources"].append(src)
            row["updated"] = session
        elif kind == "retract":
            row["status"] = "retracted"
            row["history"].append({"val": row.get("val"), "when": row.get("when"), "until": row.get("until"),
                                   "session": session, "why": f"retract:{op['why']}"})
            row["updated"] = session
        elif kind == "update":
            row["history"].append({"val": row.get("val"), "when": row.get("when"), "until": row.get("until"),
                                   "session": row.get("updated"), "why": op["why"]})
            for k in ("val", "kind", "keep", "basis", "conf", "sens"):
                if k in op:
                    row[k] = op[k]
            for k in ("when", "until", "rel"):          # absent in the op = no longer applies
                if k in op:
                    row[k] = op[k]
                elif k != "rel":
                    row.pop(k, None)
            row["sources"].append(src)
            row["updated"] = session
            if key is not None:
                row["key"] = key
        elif kind == "conflict":
            row["challenged"].append({"val": op["val"], "when": op.get("when"), "session": session, **src})
        return row

    def view(self, today=None):
        """Rows as the prompt shows them (id, ent, attr, val, when, until, keep)."""
        return [{k: r[k] for k in ("id", "ent", "type", "attr", "val", "kind", "when", "until", "keep", "key") if k in r}
                for r in self.live(today)]


def fact_fields(f):
    """Teacher fact -> op value fields."""
    out = {"ent": f["ent"], "type": f["etype"], "attr": f["attr"], "val": squash(f["val"]), "kind": f["kind"]}
    if f.get("when"):
        out["when"] = f["when"]
    if f.get("until"):
        out["until"] = f["until"]
    out.update({"keep": f["persist"], "basis": f["basis"], "conf": f["conf"], "sens": f["sens"]})
    if f.get("rel"):
        out["rel"] = list(f["rel"])
    return out


def derive_ops(session, memories):
    """Gold ops for one teacher-labelled session against the memories shown to the model.

    memories: [{"id", "key", "ent", "attr", "val", "when"?...}]; `key` links a memory to a teacher fact slot
    (None for unrelated or false memories). Rules:
      fact, slot not in the store               -> add      (also when the teacher marked change/repeat: a missed
                                                             fact's later update is simply a new fact)
      fact, slot stored with the same value     -> confirm
      fact, slot stored with another value      -> update (why = teacher's change type; `corrected` when the store held a wrong value), or
                                                   conflict when the new claim is low-confidence
      retraction, slot stored                   -> retract;  slot not stored -> nothing to do
      skip                                      -> skip
    Ops are ordered by message index, then by where their evidence starts.
    """
    by_key = {}
    for m in memories:
        if m.get("key") is not None:
            by_key.setdefault(m["key"], m)
    texts = [squash(m["text"]) for m in session["messages"]]
    ops = []
    for f in session.get("facts", []) or []:
        base = {"src": f["msg"], "evid": squash(f["evid"]), "key": f["key"]}
        m = by_key.get(f["key"])
        if "retract" in f:
            if m is not None:
                ops.append({**base, "op": "retract", "ref": m["id"], "why": f["retract"]})
            continue
        fields = fact_fields(f)
        if m is None:
            ops.append({**base, "op": "add", **fields})
        elif same_value(m["val"], fields["val"], m.get("when"), fields.get("when")):
            ops.append({**base, "op": "confirm", "ref": m["id"]})
        else:
            fields.pop("type")
            fields["ent"], fields["attr"] = m["ent"], m["attr"]      # the store's names are the stable ones
            if f["conf"] == "low":
                ops.append({**base, "op": "conflict", "ref": m["id"], **fields})
            else:
                ops.append({**base, "op": "update", "ref": m["id"], "why": f.get("change") or "corrected", **fields})
    for s in session.get("skips", []) or []:
        ops.append({"src": s["msg"], "evid": squash(s["evid"]), "op": "skip", "why": s["why"], "key": None})

    def pos(o):
        i = texts[o["src"] - 1].find(o["evid"]) if 1 <= o["src"] <= len(texts) else -1
        return (o["src"], i if i >= 0 else 10 ** 6)

    return sorted(ops, key=pos)
