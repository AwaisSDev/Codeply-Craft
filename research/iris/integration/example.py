#!/usr/bin/env python3
"""End-to-end example: Iris proposes, the guard checks, the store applies, retrieval selects.

    cd research/iris
    IRIS_LLAMA_SERVER=/path/to/llama-server python integration/example.py /path/to/iris-1-Q8_0.gguf
    python integration/example.py /path/to/merged-hf-dir          # transformers backend

Runs three batches for one fictional user and prints the store after each. No network service is contacted.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeply_iris.infer import Iris  # noqa: E402
from codeply_iris.store import MemoryStore  # noqa: E402

BATCHES = [
    ("2026-04-06T09:10", "assistant_chat", [
        {"who": "user", "text": "can you shorten this for my bio: 'I'm a data analyst at Northwind Labs in Lahore.' also I don't eat gluten, so skip the pizza jokes"},
        {"who": "assistant", "text": "Sure: \"Data analyst at Northwind Labs, Lahore.\" You could add one line about what you enjoy analysing."},
        {"who": "user", "text": "nice. the Atlas migration has to be done by 24 April, remind me to plan around it"}]),
    ("2026-04-13T18:40", "work_chat", [
        {"who": "Sana", "text": "heads up, Atlas got pushed. new deadline is 8 May"},
        {"who": "user", "text": "ok good, 8 May works. lol at this rate I'll retire before it ships"},
        {"who": "Sana", "text": "😂 btw someone said Northwind might move offices, no idea if true"}]),
    ("2026-04-20T08:05", "note", [
        {"who": "note", "text": "- still gluten-free, tell the caterer\n- wifi password is Tulip#9921x\n- dentist Thursday 3pm"}]),
]


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    iris = Iris.load(sys.argv[1])
    store = MemoryStore()
    for i, (now, source, messages) in enumerate(BATCHES, 1):
        out = iris.observe(now=now, source=source, memories=store.view(now[:10]), messages=messages)
        print(f"\n=== batch {i} ({source}, {now}): {len(out['ops'])} ops accepted, {len(out['rejected'])} rejected, "
              f"valid JSON {out['valid']}, {out['ms']} ms")
        for op in out["ops"]:
            store.apply(op, session=f"batch-{i}")
            print("  ", json.dumps({k: op[k] for k in ("op", "ref", "ent", "attr", "val", "when", "until", "why", "evid") if k in op}, ensure_ascii=False))
        for op, reason in out["rejected"]:
            print("   REJECTED", reason, json.dumps(op, ensure_ascii=False)[:120])
        print("   store:", [f"{r['id']} {r['ent']} | {r['attr']} | {r['val']}" for r in store.live(now[:10])])
    q = "Draft a note to the team about what is coming up for Atlas"
    r = iris.retrieve(now="2026-04-21T09:00", memories=store.view("2026-04-21"), query=q)
    print(f"\n=== retrieve: {q!r} -> {r['use']}")
    print("audit log entries:", len(store.log), "| superseded values kept in history:",
          sum(len(r["history"]) for r in store.rows.values()))


if __name__ == "__main__":
    main()
