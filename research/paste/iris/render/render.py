"""Render simulator events into realistic text with a local open-weights model (IRIS-DESIGN §3.2), keeping the
gold exact through iris.render.verify. Backend: any OpenAI-compatible server (llama.cpp `llama-server` on CPU,
vLLM / llama.cpp on GPU), so the same code runs here and on any Kaggle account. No API provider is used.

    python -m iris.render.render --lives lives.jsonl --out rendered.jsonl --base-url http://127.0.0.1:8080/v1
        [--max-events N] [--tries 3] [--model NAME]
Resumable: events already in OUT (by life_id + event_id) are skipped. Each output line = one event:
    {life_id, event_id, ok, tries, turns, spans, reasons, seconds, model, usage}
"""
import argparse
import json
import os
import time
import urllib.request

from .verify import verify

SYSTEM = ("You write realistic, natural message transcripts for a dataset. Write like real people: casual, varied, "
          "with small talk and typos sometimes, and keep the conversation about its stated purpose. Never describe the "
          "instructions or say what a message is for; just write the messages. Personal details "
          "come up only in passing. You must follow the fact sheet exactly: include every required detail with the exact "
          "wording given in quotes, said by the stated speaker, and never mention any other personal details, names, "
          "dates or numbers that are not given. Output only JSON.")

TURNS_SCHEMA = {"type": "object", "required": ["turns"], "additionalProperties": False,
                "properties": {"turns": {"type": "array", "minItems": 1, "maxItems": 24,
                                         "items": {"type": "object", "required": ["speaker", "text"], "additionalProperties": False,
                                                   "properties": {"speaker": {"type": "string"}, "text": {"type": "string"}}}}}}


def message_plan(ev, seed=0):
    """Assign each required detail to a numbered user (or other-speaker) message; the rest carry no personal detail."""
    import random
    fs = ev["fact_sheet"]
    n = max(1, fs.get("n_user_turns") or 1)
    rng = random.Random(f"{ev['event_id']}-{seed}")
    slots = list(range(1, n + 1))
    rng.shuffle(slots)
    plan = {i: [] for i in range(1, n + 1)}
    for k, m in enumerate(fs["must_express"]):
        plan[slots[k % n]].append(m)
    return n, plan


def prompt(ev, seed=0):
    fs = ev["fact_sheet"]
    src = fs["source"]
    who = fs["participants"]
    n, plan = message_plan(ev, seed)
    other = who[1].split()[0] if len(who) > 1 else "assistant"
    if src == "email":
        form = (f"One email from {who[0]} to {who[1] if len(who) > 1 else 'the user'}: a single turn whose speaker is "
                f"\"{who[0].split()[0]}\", starting with a 'Subject:' line.")
        lines = [f"Purpose: {fs['purpose']}", f"Format: {form}", f"Language: {fs['language']}."]
        for m in fs["must_express"]:
            lines.append(f"- Include: {m['instruction']} (exact words: {', '.join(repr(a) for a in m['anchors'])})")
    else:
        reply = "an AI assistant reply of 40 to 120 words" if src == "assistant_chat" else f"a short reply from {other}"
        speaker2 = "assistant" if src == "assistant_chat" else other
        lines = [f"Purpose: {fs['purpose']}", f"Language: {fs['language']}.",
                 f"Write exactly {n} messages from speaker \"user\" ({who[0]}), each followed by {reply} "
                 f"(speaker \"{speaker2}\"). Message plan:"]
        for i in range(1, n + 1):
            items = plan[i]
            if not items:
                lines.append(f"  user message {i}: an ordinary follow-up in this conversation (no personal details).")
            for m in items:
                sp = "user" if m.get("speaker", "user") == "user" else m["speaker"]
                where = f"user message {i}" if sp == "user" else f"{sp}'s reply after user message {i}"
                lines.append(f"  {where}: {m['instruction']} -- use the exact words "
                             f"{', '.join(repr(a) for a in m['anchors'])}, in passing, with this meaning and no other.")
    lines.append("Do not mention any other people, names, dates, numbers, places or personal details.")
    lines.append('Return {"turns": [{"speaker": "...", "text": "..."}, ...]}.')
    return "\n".join(lines)


def call(base_url, model, ev, temperature=0.8, timeout=900, seed=0):
    body = {"model": model, "temperature": temperature, "max_tokens": 2400,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt(ev, seed)}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "turns", "schema": TURNS_SCHEMA}}}
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.load(r)
    txt = out["choices"][0]["message"]["content"]
    return json.loads(txt)["turns"], out.get("usage", {})


def extra_forbidden(life, ev):
    """Every pool value not required here, and the names of people in the life who are not in this conversation."""
    from data import ontology as O
    from iris.sim import pools as P
    fs = ev["fact_sheet"]
    said = {a.lower() for m in fs["must_express"] for a in m["anchors"]}
    own = " ".join(m["instruction"] for m in fs["must_express"]).lower() + " " + fs["purpose"].lower()
    vals = {v for c in O.CLASSES for v in c[3]} | {v for _, _, _, vs in P.IRIS_SLOTS if vs for v in vs} | \
           {v for _, _, _, vs in P.SENSITIVE for v in vs}
    context = {x.lower() for x in life.get("projects", []) + [life.get("org", ""), life.get("school", "")] if x}
    names = set()
    for p in life.get("people", []):
        full = p["name"]
        if full not in fs["participants"] and full.split()[0].lower() not in own:
            names.add(full.split()[0])
    from .verify import distinctive
    return sorted(v for v in vals | names if len(v) > 3 and distinctive(v) and v.lower() not in said and v.lower() not in own
                  and v.lower() not in context)


def render_event(ev, base_url, model, tries=3, life=None):
    t0, last, usage_all = time.time(), None, []
    if life is not None:
        ev = dict(ev, fact_sheet=dict(ev["fact_sheet"], must_not_contain=sorted(set(ev["fact_sheet"]["must_not_contain"]) |
                                                                                   set(extra_forbidden(life, ev)))))
    for k in range(1, tries + 1):
        try:
            turns, usage = call(base_url, model, ev, temperature=0.8 if k == 1 else 0.9, seed=k)
        except Exception as e:                                   # malformed JSON or server error: retry
            last = {"turns": None, "reasons": [f"call failed: {type(e).__name__}: {str(e)[:200]}"], "spans": []}
            continue
        usage_all.append(usage)
        ok, reasons, spans = verify(ev, turns)
        last = {"turns": turns, "reasons": reasons, "spans": spans}
        if ok:
            return {"ok": True, "tries": k, **last, "seconds": round(time.time() - t0, 1), "usage": usage_all}
    return {"ok": False, "tries": tries, **last, "seconds": round(time.time() - t0, 1), "usage": usage_all}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lives", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="local")
    ap.add_argument("--max-events", type=int, default=0)
    ap.add_argument("--tries", type=int, default=3)
    a = ap.parse_args()
    done = set()
    if os.path.exists(a.out):
        done = {(r["life_id"], r["event_id"]) for r in map(json.loads, open(a.out)) if r.get("event_id")}
    n = 0
    with open(a.out, "a") as fh:
        for line in open(a.lives):
            life = json.loads(line)
            for ev in life["events"]:
                if ev["render"] != "llm" or (life["life_id"], ev["event_id"]) in done:
                    continue
                if a.max_events and n >= a.max_events:
                    return
                res = render_event(ev, a.base_url, a.model, a.tries, life=life)
                fh.write(json.dumps({"life_id": life["life_id"], "event_id": ev["event_id"], "source": ev["source"],
                                     "n_gold": len(ev["gold"]["observations"]) + len(ev["gold"]["plans"]),
                                     "model": a.model, **res}) + "\n")
                fh.flush()
                n += 1
                print(json.dumps({"n": n, "event": ev["event_id"], "ok": res["ok"], "tries": res["tries"], "s": res["seconds"],
                                  "why": res["reasons"][:2]}), flush=True)


if __name__ == "__main__":
    main()
