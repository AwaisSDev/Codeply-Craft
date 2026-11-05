"""Meaning check of verified renders (IRISBENCH-PROTOCOL §4 generator rule): a checker model (ideally stronger than
and different from the generator) reads each fact sheet and its rendered text and reports, per required item, whether
the text states it with the intended meaning (same person, same attribute, same certainty), and lists any other
personal fact the text states. Exact-string verification cannot catch meaning drift ("the project uses Django" ->
"I have worked with Django") or invented facts about others; this does, on a sample.

    python -m iris.render.meaning_check --lives L.jsonl --rendered R.jsonl --out M.jsonl --base-url ... [--sample 100]
Output lines: {life_id, event_id, faithful: [bool per required item], extra_facts: [str], ok: bool}.
"""
import argparse
import json
import os
import random
import urllib.request

SCHEMA = {"type": "object", "required": ["items", "extra_facts"], "additionalProperties": False,
          "properties": {"items": {"type": "array", "items": {"type": "object", "required": ["n", "stated_with_this_meaning"],
                                                               "additionalProperties": False,
                                                               "properties": {"n": {"type": "integer"},
                                                                              "stated_with_this_meaning": {"type": "boolean"}}}},
                         "extra_facts": {"type": "array", "items": {"type": "string", "maxLength": 160}, "maxItems": 6}}}

SYSTEM = ("You check a generated transcript against its specification. Be strict and literal. For each REQUIRED item, "
          "answer whether the transcript states exactly that fact with that meaning (same person, same value, same time or "
          "date, same certainty: a joke stays a joke, a hypothetical stays hypothetical, a suggestion stays a suggestion, "
          "a correction is clearly a correction, a declined plan stays declined). Then list, as short quotes, every OTHER "
          "lasting, memory-worthy fact the transcript asserts about the user, a named person or a project: a preference, "
          "habit or routine, personal fact (job, family, health, location, possessions), relationship, project decision or "
          "deadline, commitment, or a plan with a time - whoever says it, including the user agreeing to an assistant's "
          "suggestion. NOT extra: restating, paraphrasing or reacting to a REQUIRED item; greetings, small talk, questions, "
          "thanks, feelings about the moment; the AI assistant's generic advice, suggestions or recipes that the user does "
          "not adopt; vague filler with no specific content; the conversation's given PURPOSE itself (what the user asks for or "
          "talks about there, e.g. asking for gift ideas or a recipe is not a fact about them), and someone merely asking about, "
          "being interested in or thanking for something. Ask: would a careful personal-memory system store it as a lasting "
          "fact about this person? If yes, list it. Most transcripts have no extra facts.")


def check(base_url, model, ev, turns, timeout=900):
    items = "\n".join(f"{i}. [{m.get('speaker', 'user')}] {m['instruction']}" for i, m in enumerate(ev["fact_sheet"]["must_express"])) or "(none)"
    text = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)
    fs = ev["fact_sheet"]
    user = (f"PURPOSE: {fs.get('purpose', '')}\nPARTICIPANTS: {', '.join(fs.get('participants', []))}\n"
            f"REQUIRED items:\n{items}\n\nTRANSCRIPT:\n{text}\n\nJSON:")
    body = {"model": model, "temperature": 0.0, "max_tokens": 600, "messages": [{"role": "system", "content": SYSTEM},
                                                                              {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "check", "schema": SCHEMA}}}
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(json.load(r)["choices"][0]["message"]["content"])


def gate(base_url, model, ev, turns):
    """In-loop meaning gate for rendering: (ok, reasons). ok = every required item faithful and no extra fact."""
    res = check(base_url, model, ev, turns)
    need = len(ev["fact_sheet"]["must_express"])
    faithful = [bool(x["stated_with_this_meaning"]) for x in sorted(res["items"], key=lambda x: x["n"])]
    reasons = [f"meaning: item {i} not faithful" for i in range(need) if i >= len(faithful) or not faithful[i]]
    reasons += [f"meaning: extra fact: {x[:80]}" for x in res["extra_facts"]]
    return not reasons, reasons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lives", required=True)
    ap.add_argument("--rendered", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="checker")
    ap.add_argument("--sample", type=int, default=100)
    a = ap.parse_args()
    evs = {(l["life_id"], e["event_id"]): e for l in map(json.loads, open(a.lives)) for e in l["events"]}
    rows = [r for r in map(json.loads, open(a.rendered)) if r.get("ok")]
    random.Random(0).shuffle(rows)
    done = {(r["life_id"], r["event_id"]) for r in map(json.loads, open(a.out))} if os.path.exists(a.out) else set()
    with open(a.out, "a") as fh:
        for r in rows[:a.sample]:
            k = (r["life_id"], r["event_id"])
            if k in done:
                continue
            ev = evs[k]
            try:
                res = check(a.base_url, a.model, ev, r["turns"])
                faithful = [bool(x["stated_with_this_meaning"]) for x in sorted(res["items"], key=lambda x: x["n"])]
                need = len(ev["fact_sheet"]["must_express"])
                ok = (len(faithful) >= need and all(faithful[:need])) and not res["extra_facts"]
                out = {"life_id": k[0], "event_id": k[1], "generator": r.get("model"), "faithful": faithful,
                       "extra_facts": res["extra_facts"], "ok": ok}
            except Exception as e:
                out = {"life_id": k[0], "event_id": k[1], "generator": r.get("model"), "error": f"{type(e).__name__}: {str(e)[:160]}"}
            fh.write(json.dumps(out) + "\n"); fh.flush()


if __name__ == "__main__":
    main()
