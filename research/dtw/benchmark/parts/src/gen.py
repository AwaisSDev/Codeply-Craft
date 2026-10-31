import json, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/home/user/Codeply-Craft/research/dtw/benchmark/parts/lg.jsonl"
EXAMPLES = []


def C(*lines, mins=2, project=None):
    e = {"source": "chat", "trust": "user", "minutes_ago": mins, "text": "\n".join(lines)}
    if project:
        e["project"] = project
    return e


def EM(sender, body, mins=60, project=None):
    e = {"source": "email", "trust": "external", "minutes_ago": mins,
         "text": f"Email the user received (from {sender}): {body}"}
    if project:
        e["project"] = project
    return e


def H(body, mins=30):
    return {"source": "heard", "trust": "mixed", "minutes_ago": mins, "text": f"Heard around the user: {body}"}


def K(i, kind, slot, value, text, project=None):
    m = {"id": f"m{i}", "kind": kind, "slot": slot, "value": value, "text": text}
    if project:
        m["project"] = project
    return m


def O(kind, slot, value, text, cert, imp, about, ev, **kw):
    o = {"kind": kind, "slot": slot, "value": value, "text": text, "certainty": cert,
         "importance": imp, "about": about, "evidence": ev}
    o.update(kw)
    return o


def P(what, when, ev, tt=None, where="", who=None, **kw):
    p = {"what": what, "when": when, "where": where, "who": who or [], "evidence": ev}
    if tt:
        p["time_text"] = tt
    p.update(kw)
    return p


def X(num, task, lang, anchor, events, obs=(), plans=(), known=(), expect=None):
    EXAMPLES.append({"id": f"b-lg-{num:03d}", "task": task, "lang": lang, "anchor": anchor,
                     "events": list(events), "known": list(known), "observations": list(obs),
                     "plans": list(plans), "expect": expect or {}})


for f in ("long1.py", "long2.py", "noise.py"):
    exec(open(os.path.join(HERE, f), encoding="utf-8").read())

with open(OUT, "w", encoding="utf-8") as fh:
    for ex in EXAMPLES:
        fh.write(json.dumps(ex, ensure_ascii=False) + "\n")

from collections import Counter
print(len(EXAMPLES), Counter(e["task"] for e in EXAMPLES), Counter((e["task"], e["lang"]) for e in EXAMPLES))
print(Counter((e["task"], e["anchor"]) for e in EXAMPLES))
for e in EXAMPLES:
    n = sum(len(ev["text"]) for ev in e["events"])
    if e["task"] == "long" and not (600 <= n <= 2500):
        print("LENGTH", e["id"], n)
