"""Simulated lives (research/paste/iris/sim/life.py) -> iris.v1 examples (DATA.md).

Every label comes from the simulator's world, never from a model: the gold op, target memory, value, certainty,
sensitivity and the verbatim anchors that become evidence quotes. Each example is one request (what the runner would
send Iris) and the gold output (what a perfect Iris answers), and must pass `contract.validate` + `verify_evidence`.

Examples:
  observe   one event, the store as it stood just before it (gold state replayed in order), candidate memories:
            every memory the gold touches + same-entity and random distractors (≤ 30), shuffled, local ids
  retrieve  one agent task: the needed memories + forbidden / sensitive + stale + distractors (≤ 40)

History noise (TRAINING.md §3, own-output training): with `noise > 0` the candidate memories are perturbed the way a
real model's store goes wrong: a near-duplicate of a touched memory (gold: also `link same_as`), and unrelated wrong
memories (gold: left alone). Round 2 replaces this with Iris's own earlier outputs (`history` argument).

    python -m irisarch.build lives.jsonl --out examples.jsonl [--noise 0.3] [--seed 1] [--plain]

`--plain` renders events that still lack text from their fact sheet as plain sentences (marked render "plain"): for
pipeline tests only, never for training or IrisBench numbers.
"""
import argparse
import json
import random
import sys

from . import contract as C

OP_MAP = {"new": "add", "reinforce": "reinforce", "update": "update", "contradict": "correct", "none": "ignore"}
REASON = {"add": "new information", "reinforce": "said again", "update": "this changed", "correct": "an earlier value was wrong",
          "ignore": "not meant as a real fact"}
MAX_MEM_OBS, MAX_MEM_RET = 30, 40


def plain_text(ev):
    """Fact sheet -> plain lines that contain every anchor verbatim (pipeline tests only)."""
    sheet = ev.get("fact_sheet") or {}
    lines = [f"{m.get('speaker', 'user')}: {m['instruction']}" for m in sheet.get("must_express", [])]
    return "\n".join(lines) or sheet.get("purpose", "")


def _entity_type(life, name):
    if name in ("user", life["user"]["name"]):
        return "user"
    if name in life.get("projects", []):
        return "project"
    if name in (life.get("org"), life.get("school")):
        return "organisation"
    return "person"


def _anchor_for(value, anchors, text):
    """The evidence quote: the anchor that is the value if there is one, else the first anchor found in the text."""
    for a in sorted(anchors or [], key=lambda a: (a != value, -len(a))):
        if a and a.lower() in text.lower():
            return a
    return value if value and value.lower() in text.lower() else None


def _mem_row(lid, m):
    return {"id": lid, "kind": m["kind"], "slot": m["slot"], "value": m["value"], "entity": m["entity"],
            "text": f"{m['entity'] if m['entity'] != 'user' else 'The user'}'s {m['slot']} is {m['value']}.",
            "status": m.get("status", "confirmed"), "updated": m.get("updated_iso", "")}


class Replay:
    """The gold store as it stands after each event (one record per memory id, plans by id)."""

    def __init__(self, life):
        self.life = life
        self.mem = {}

    def apply(self, ev):
        for o in ev["gold"]["observations"]:
            mid = o.get("_memory")
            if not mid or o["op"] == "none":
                continue
            cur = self.mem.get(mid, {})
            self.mem[mid] = {**cur, "id": mid, "entity": o["entity"], "slot": o["slot"], "value": o["value"],
                             "kind": o["kind"], "status": "confirmed", "updated_iso": ev["at_iso"]}


def _items(ev, text, local, rnd):
    """Gold observations -> iris.v1 items (evidence quotes checked against the text)."""
    sheet = {m["instruction"]: m for m in (ev.get("fact_sheet") or {}).get("must_express", [])}
    anchors_all = [a for m in sheet.values() for a in m.get("anchors", [])]
    items, missing = [], 0
    for o in ev["gold"]["observations"]:
        op = OP_MAP[o["op"]]
        if o.get("sensitivity") == "secret":                  # never stored: say why, write nothing
            op = "ignore"
        q = _anchor_for(o["value"], anchors_all, text)
        if q is None:
            missing += 1
            continue
        lvl = o.get("sensitivity", "personal")
        it = {"op": op, "evidence": [{"event": "ev1", "quote": q}],
              "basis": "stated" if o["certainty"] == "stated" else "inferred",
              "confidence": 0.95 if o["certainty"] == "stated" else 0.75 if op != "ignore" else 0.9,
              "persist": "ignore" if op == "ignore" else "reject" if lvl == "secret" else
              "session" if o["kind"] == "context" else "store",
              "reason": (f"secret ({o.get('sensitivity_category', 'credentials')}): never stored" if o.get("sensitivity") == "secret"
                         else f"{REASON[op]} ({o.get('_how', '')})")[:160]}
        if op == "ignore":
            items.append(it)
            continue
        ref = local["mem"].get(o.get("target") or o.get("_memory")) if op != "add" else None
        if op != "add" and not ref:
            missing += 1
            continue
        ent = {"name": o["entity"] if o["entity"] != "user" else "user", "type": _entity_type(local["life"], o["entity"])}
        if o["entity"] in local["ent"]:
            ent["id"] = local["ent"][o["entity"]]
        it.update({"entity": ent, "about": o["about"], "kind": o["kind"], "attribute": o["slot"], "value": o["value"],
                   "text": o["text"][:280], "certainty": o["certainty"] if o["certainty"] in ("stated", "implied", "temporary") else "stated",
                   "privacy": {"level": lvl, **({"category": o["sensitivity_category"]} if o.get("sensitivity_category") else {})}})
        if ref:
            it["ref"] = ref
        if o.get("valid_from"):
            it["valid"] = {"from": o["valid_from"]}
        if o["kind"] == "context":
            it.setdefault("valid", {})["temporary"] = True
        if o.get("project"):
            it["project"] = o["project"]
        items.append(it)
    return items, missing


def observe_examples(life, rnd, noise=0.0, plain=False):
    rep = Replay(life)
    out, stats = [], {"events": 0, "skipped_no_text": 0, "skipped_unanchored": 0, "empty": 0}
    for ev in life["events"]:
        text = ev.get("text")
        render = ev.get("render")
        if not text and plain and ev.get("fact_sheet"):
            text, render = plain_text(ev), "plain"
        if not text:
            stats["skipped_no_text"] += 1
            rep.apply(ev)
            continue
        stats["events"] += 1
        touched = [o.get("target") or o.get("_memory") for o in ev["gold"]["observations"] if o["op"] != "new"]
        touched = [t for t in touched if t in rep.mem]
        ents_here = {o["entity"] for o in ev["gold"]["observations"]} | set(ev.get("participants", []))
        same_ent = [m for m in rep.mem if m not in touched and rep.mem[m]["entity"] in ents_here]
        others = [m for m in rep.mem if m not in touched and m not in same_ent]
        rnd.shuffle(same_ent), rnd.shuffle(others)
        cands = (touched + same_ent[:8] + others)[:MAX_MEM_OBS]
        rows = [dict(rep.mem[m]) for m in cands]
        extra_items = []
        if noise and touched and rnd.random() < noise:          # a near-duplicate the real store would have made
            src = rep.mem[touched[0]]
            rows.append({**src, "id": f"dup:{src['id']}", "slot": f"{src['slot']} (noted)"})
        if noise and rnd.random() < noise:                       # an unrelated wrong memory: must be left alone
            rows.append({"id": "noise:1", "entity": "user", "slot": "favourite colour", "value": rnd.choice(["teal", "maroon"]),
                         "kind": "preference", "status": "tentative", "updated_iso": ""})
        rnd.shuffle(rows)
        local = {"life": life, "mem": {}, "ent": {}}
        mem_rows = []
        for i, r in enumerate(rows, 1):
            local["mem"][r["id"]] = f"m{i}"
            mem_rows.append(_mem_row(f"m{i}", r))
        not_people = {"user", life["user"]["name"], "assistant", "external", "unknown", ""}   # sender labels, not entities
        people = sorted(({r["entity"] for r in rows} | ents_here) - not_people)
        roster = [{"id": "e0", "name": life["user"]["name"], "type": "user"}]
        local["ent"]["user"] = "e0"
        for i, n in enumerate(people, 1):
            local["ent"][n] = f"e{i}"
            roster.append({"id": f"e{i}", "name": n, "type": _entity_type(life, n)})
        items, missing = _items(ev, text, local, rnd)
        stats["skipped_unanchored"] += missing
        for r in rows:                                            # the duplicate: link it to what it duplicates
            if r["id"].startswith("dup:"):
                extra_items.append({"op": "link", "ref": local["mem"][r["id"]], "related": [local["mem"][r["id"][4:]]],
                                    "link": "same_as", "evidence": [], "basis": "inferred", "confidence": 0.85,
                                    "persist": "store", "reason": "duplicate of an existing memory"})
        plans = []
        for pg in ev["gold"].get("plans", []):                     # commitments, with their status
            q = _anchor_for(pg.get("what", ""), pg.get("anchors", []), text)
            if q is None:
                stats["skipped_unanchored"] += 1
                continue
            pl = {"what": pg["what"], "status": pg.get("status", "confirmed"), "evidence": [{"event": "ev1", "quote": q}],
                  "confidence": 0.95 if pg.get("status") == "confirmed" else 0.8}
            for k in ("when", "where"):
                if pg.get(k):
                    pl[k] = pg[k]
            if pg.get("who"):
                pl["who"] = pg["who"]
            plans.append(pl)
        rels = []
        for rg in ev["gold"].get("relations", []):                 # who is who
            q = next((n for n in (rg.get("b"), rg.get("a"), rg.get("detail")) if n and n.lower() in text.lower()), None)
            if q and rg.get("relation") in C.RELATIONS:
                rels.append({"a": rg["a"], "relation": rg["relation"], "b": rg["b"], **({"detail": rg["detail"][:80]} if rg.get("detail") else {}),
                             "evidence": [{"event": "ev1", "quote": q}]})
        request = {"mode": "observe", "now": ev["at_iso"], "events": [{"id": "ev1", "source": ev["source"], "at": ev["at_iso"],
                   "trust": ev.get("trust", "user"), "text": text}], "memories": mem_rows, "entities": roster}
        gold = {"v": C.VERSION, "mode": "observe", "items": items + extra_items, "plans": plans, "relations": rels}
        if not (gold["items"] or plans or rels):
            stats["empty"] += 1
        out.append({"id": f"{life['life_id']}:{ev['event_id']}", "life": life["life_id"], "split": life["split"],
                    "render": render, "request": request, "gold": gold})
        rep.apply(ev)
    return out, stats


def retrieve_examples(life, rnd):
    """Agent tasks -> retrieve examples: picks = the needed memories; forbidden ones are never picked for a frontier
    agent (and are marked `share: no` if a task needs them)."""
    out = []
    mems = {k: v for k, v in life.get("final_memories", {}).items()}
    for t in life.get("tasks", []):
        needed = [m for m in t.get("needed", []) if m in mems]
        forbidden = [m for m in t.get("forbidden", []) if m in mems]
        others = [m for m in mems if m not in needed and m not in forbidden]
        rnd.shuffle(others)
        cands = needed + forbidden + others[: max(0, MAX_MEM_RET - len(needed) - len(forbidden))]
        rnd.shuffle(cands)
        local = {m: f"m{i}" for i, m in enumerate(cands, 1)}
        rows = [_mem_row(local[m], {**mems[m], "updated_iso": ""}) for m in cands]
        picks = [{"ref": local[m], "relevance": 0.9, "why": f"needed: {mems[m]['slot']}"[:120],
                  "share": "no" if (t.get("frontier") and m in forbidden) else "yes"} for m in needed]
        request = {"mode": "retrieve", "now": "", "task": t["request"], "frontier": bool(t.get("frontier")), "memories": rows}
        out.append({"id": f"{life['life_id']}:{t['task_id']}", "life": life["life_id"], "split": life["split"],
                    "render": "template", "request": request, "gold": {"v": C.VERSION, "mode": "retrieve", "picks": picks}})
    return out


def check(ex):
    """Errors in one example's gold (it must be a perfect answer to its own request)."""
    return C.validate(ex["gold"], ex["request"]) + C.verify_evidence(ex["gold"], ex["request"])


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("lives")
    ap.add_argument("--out", required=True)
    ap.add_argument("--noise", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--plain", action="store_true")
    a = ap.parse_args(argv)
    rnd = random.Random(a.seed)
    total, bad, agg = 0, 0, {}
    with open(a.out, "w") as f:
        for line in open(a.lives):
            life = json.loads(line)
            obs, st = observe_examples(life, rnd, a.noise, a.plain)
            for k, v in st.items():
                agg[k] = agg.get(k, 0) + v
            for ex in obs + retrieve_examples(life, rnd):
                errs = check(ex)
                if errs:
                    bad += 1
                    print(f"{ex['id']}: {errs[:2]}", file=sys.stderr)
                    continue
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")
                total += 1
    print(json.dumps({"written": total, "rejected": bad, **agg}))


if __name__ == "__main__":
    main()
