#!/usr/bin/env python3
"""Topic-boundary analysis of r2 / r3 on validation (read-only; reuses diagnose.py's replay of cached generations).

Does the model act on memories that belong to other conversations? In the open loop every session is shown its gold
store plus unrelated memories from other episodes of the split (key = None in data/built/val.jsonl). In the closed
loop the store holds only what the model itself wrote for this episode, so no foreign memories are shown by
construction (the model's own unmatched rows are counted elsewhere: diagnosis.json store_false_rows).

Counted per checkpoint and mode:
  sessions_with_unrelated_memories_shown   sessions whose MEMORIES list contains another episode's memory
  update/retract/confirm_total             predicted ops of that type (after the guard)
  <op>_on_unrelated_memory                 of those, ops whose ref points at another episode's memory
  pred_entity_ambiguous_firstname_not_in_store
                                           predicted content ops whose entity is a bare first name that is not a
                                           stored entity but is the first word of a stored multi-word entity
                                           (look-alike first-name confusion)

This file was added because the committed diagnosis_extra.json held a topic_boundary section that no committed
script produced. Output: audit-r4/topic_boundary.json (diagnosis_extra.json is left as committed).

    cd research/iris && python3 audit-r4/topic_boundary.py
"""
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "audit-r4"))
import diagnose as D  # noqa: E402
from codeply_iris import contract  # noqa: E402


def analyse(recs, foreign_possible):
    c = Counter()
    for r in recs:
        mems = {m["id"]: m for m in r["memories"]}
        foreign = {i for i, m in mems.items() if foreign_possible and m.get("key") is None}
        c["sessions"] += 1
        c["sessions_with_unrelated_memories_shown"] += bool(foreign)
        ents = {m["ent"] for m in mems.values()}
        firsts = {e.split()[0].lower() for e in ents if len(e.split()) > 1}
        for p in r["pred"]:
            op = p["op"]
            if op in ("update", "retract", "confirm"):
                c[f"{op}_total"] += 1
                if p.get("ref") in foreign:
                    c[f"{op}_on_unrelated_memory"] += 1
            if op in contract.PERSISTENT_OPS:
                e = p.get("ent", "")
                if len(e.split()) == 1 and e not in ents and e.lower() in firsts:
                    c["pred_entity_ambiguous_firstname_not_in_store"] += 1
    return dict(c)


def main():
    out = {}
    for label in D.LABELS:
        out[label] = {"open": analyse(D.open_records(label), True), "closed": analyse(D.closed_records(label), False)}
        print(label, json.dumps(out[label]))
    (ROOT / "audit-r4" / "topic_boundary.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
