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
                         "extra_facts": {"type": "array", "items": {"type": "string"}, "maxItems": 10}}}

SYSTEM = ("You check a generated transcript against its specification. Be strict and literal. For each REQUIRED item, "
          "answer whether the transcript states exactly that fact with that meaning (same person, same attribute, same "
          "certainty: a joke stays a joke, a suggestion stays a suggestion). Then list every OTHER personal fact the "
          "transcript states about any real person (the user or anyone they know): preferences, possessions, jobs, plans, "
          "dates, places, health, numbers. Restating, paraphrasing or reacting to a REQUIRED item is NOT an extra fact. Generic "
          "small talk and the AI assistant's general advice or questions are not personal facts.")


def check(base_url, model, ev, turns, timeout=900):
    items = "\n".join(f"{i}. [{m.get('speaker', 'user')}] {m['instruction']}" for i, m in enumerate(ev["fact_sheet"]["must_express"])) or "(none)"
    text = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)
    user = f"REQUIRED items:\n{items}\n\nTRANSCRIPT:\n{text}\n\nJSON:"
    body = {"model": model, "temperature": 0.0, "max_tokens": 600, "messages": [{"role": "system", "content": SYSTEM},
                                                                              {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "check", "schema": SCHEMA}}}
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(json.load(r)["choices"][0]["message"]["content"])


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
