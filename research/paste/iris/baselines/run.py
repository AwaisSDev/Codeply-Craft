"""Run an extraction baseline over rendered IrisBench events (IRIS-IMPLEMENTATION-PLAN step 6), open loop: before each
event the system is shown the *gold* memories known at that time (as production's prompt shows KNOWN memories), so
extraction quality is measured without error cascades (closed-loop runs come later).

Systems:
  rules        production rules extractor (research port, no model)
  prodprompt   production prompt (context-prompt.js v2, 'full') -> a local OpenAI-compatible model
  iris         Iris schema prompt with memory ids (op / target / sensitivity / entity) -> a local model, JSON-schema constrained

    python -m iris.baselines.run --lives lives.jsonl --rendered rendered.jsonl --system iris --out pred.jsonl
        [--base-url http://127.0.0.1:8080/v1] [--model NAME] [--max-events N]
Only verified renders (ok) and template events (calendar, screen) are used. Resumable by (life_id, event_id).
"""
import argparse
import json
import os
import time
import urllib.request

from iris import schema as S
from iris.sim.life import GoldStore

from .production import production_messages, rules_extract, to_iris

SOURCE_MAP = {"assistant_chat": ("chat", "user"), "personal_chat": ("chat", "mixed"), "work_chat": ("chat", "mixed"),
              "email": ("email", "external"), "calendar": ("chat", "user"), "screen": ("chat", "user"), "document": ("chat", "mixed")}

IRIS_SYSTEM = """You are Iris, the local context engine of a personal assistant. Read ONE event (a chat, email, calendar entry or screen text) and return what should change in the user's memory, as JSON matching the schema.

Rules:
- Most events contain nothing worth keeping: return empty lists. Only lasting facts, preferences, routines, styles, project decisions, to-dos and plans count. Never invent anything not in the event.
- observations: one per fact. entity = "user" or the person's / project's name. slot = what it is about in 1-4 words (reuse a KNOWN slot exactly when it is the same thing). value = a few words copied from the event. text = one short third-person sentence.
- op: "new" (not known yet), "reinforce" (same value as a KNOWN memory), "update" (the world changed: new value for a KNOWN memory), "contradict" (the user corrects a KNOWN memory that was wrong), "none" (said but not a real fact). target = the KNOWN memory id for reinforce / update / contradict.
- certainty: stated, implied, temporary, joking, hypothetical, quoting. Jokes, hypotheticals and quotes of others are op "none".
- about: user / person / project. A fact about another person is kind "fact".
- sensitivity: "secret" (card numbers, PINs, passwords, ID or passport numbers), "private" (health, medication, therapy, salary, home address), "personal" (other personal facts), "public".
- plans: meetings, calls, outings with a time: what, when (YYYY-MM-DDTHH:MM), where, who, status: "suggested" (someone proposed it, not agreed), "tentative" (proposed by email or unconfirmed), "confirmed" (the user agreed or it is in the calendar), "declined", "cancelled", "done". target = KNOWN plan id if it is an existing plan.
- relations: only new relationships between people stated in the event."""


def event_text(ev, rendered):
    if ev["render"] != "llm":
        return ev["text"]
    turns = rendered["turns"]
    if ev["source"] == "email":
        return "\n".join(t["text"] for t in turns)
    lab = lambda sp: "User" if sp.lower() in ("user", "me") else ("Assistant" if sp.lower() == "assistant" else sp)
    return "\n".join(f"{lab(t['speaker'])}: {t['text']}" for t in turns)


def known_before(life, upto_event_id):
    """Gold memories and plans as they stood just before the event (replaying gold ops in time order)."""
    g = GoldStore()
    plans = {}
    for ev in life["events"]:
        if ev["event_id"] == upto_event_id:
            break
        for o in ev["gold"]["observations"]:
            g.observe(ev["at"], o["entity"], o["slot"], o["value"], o["kind"], o["certainty"], o["sensitivity"],
                      o["sensitivity_category"], correction=o["op"] == "contradict")
        for p in ev["gold"]["plans"]:
            plans[p["id"]] = p
    return list(g.mem.values()), list(plans.values())


def call(base_url, model, messages, schema=None, timeout=900):
    body = {"model": model, "temperature": 0.0, "max_tokens": 1200, "messages": messages,
            "response_format": ({"type": "json_schema", "json_schema": {"name": "x", "schema": schema}} if schema else {"type": "json_object"})}
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.load(r)
    return json.loads(out["choices"][0]["message"]["content"]), out.get("usage", {})


def iris_messages(ev, text, known, plans, life):
    k = "\n".join(f"- [{m['id']}] {m['entity']} · {m['slot']}: {m['value']}" for m in known[-40:]) or "(none)"
    pl = "\n".join(f"- [{p['id']}] {p['what']} · {p['when']} · {p.get('where', '')} · {p['status']}" for p in plans[-20:]) or "(none)"
    user = (f"Now: {ev['at_iso']}\nUser: {life['user']['name']}\nKNOWN memories:\n{k}\nKNOWN plans:\n{pl}\n\n"
            f"EVENT ({ev['source']}, from: {ev['trust']}):\n<event>\n{text}\n</event>\nJSON:")
    return [{"role": "system", "content": IRIS_SYSTEM}, {"role": "user", "content": user}]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lives", required=True)
    ap.add_argument("--rendered", required=True)
    ap.add_argument("--system", required=True, choices=("rules", "prodprompt", "iris"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="local")
    ap.add_argument("--max-events", type=int, default=0)
    a = ap.parse_args()
    rend = {(r["life_id"], r["event_id"]): r for r in map(json.loads, open(a.rendered)) if r.get("ok")}
    done = {(r["life_id"], r["event_id"]) for r in map(json.loads, open(a.out))} if os.path.exists(a.out) else set()
    n = 0
    with open(a.out, "a") as fh:
        for line in open(a.lives):
            life = json.loads(line)
            for ev in life["events"]:
                key = (life["life_id"], ev["event_id"])
                if key in done or (ev["render"] == "llm" and key not in rend):
                    continue
                if a.max_events and n >= a.max_events:
                    return
                text = event_text(ev, rend.get(key))
                src, trust = SOURCE_MAP[ev["source"]]
                pev = {"source": src, "trust": trust, "at": ev["at"], "text": text}
                known, plans = known_before(life, ev["event_id"])
                t0, raw, usage, err = time.time(), None, {}, ""
                try:
                    if a.system == "rules":
                        raw = rules_extract([pev]); out = to_iris(raw)
                    elif a.system == "prodprompt":
                        kn = [{"kind": m["kind"], "slot": m["slot"], "value": m["value"]} for m in known]
                        raw, usage = call(a.base_url, a.model, production_messages([pev], known=kn, now=ev["at"], projects=life["projects"]))
                        out = to_iris(raw)
                    else:
                        raw, usage = call(a.base_url, a.model, iris_messages(ev, text, known, plans, life), schema=S.EXTRACTION_SCHEMA)
                        out = raw
                except Exception as e:
                    out, err = {"observations": [], "plans": [], "relations": []}, f"{type(e).__name__}: {str(e)[:200]}"
                fh.write(json.dumps({"life_id": life["life_id"], "event_id": ev["event_id"], "system": a.system, "model": a.model,
                                     "output": out, "raw": raw, "usage": usage, "error": err,
                                     "seconds": round(time.time() - t0, 2)}) + "\n")
                fh.flush()
                n += 1


if __name__ == "__main__":
    main()
