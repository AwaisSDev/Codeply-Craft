"""API realizer: the same episode plans, worded by Claude instead of templates (owner decision 2: a pilot, compared).

The model only chooses wording. Labels come from the plan; an output whose tags do not match the plan exactly is
rejected (counted as a realisation failure, never repaired by hand).

    python -m data.realize_api estimate --plans <pilot-plans.jsonl> [--model claude-opus-5-5]   # free: token counting
    python -m data.realize_api run      --plans <pilot-plans.jsonl> --out <dir> --max-usd 10       # spends money

Reads ANTHROPIC_API_KEY from the environment (the owner's key file is sourced by the caller; never stored).
"""
import argparse
import copy
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from data.assemble import assemble  # noqa: E402
from data.build import finalize  # noqa: E402

PRICES = {  # USD per 1M tokens, Anthropic first-party (claude-api skill table, cached 2026-10-06); batch = 50 %
    "claude-opus-5-5": (4.00, 20.00), "claude-sonnet-5-5": (2.00, 10.00), "claude-haiku-5-5": (0.10, 0.50)}

SYSTEM = """You write realistic chat conversations between a user and an AI assistant, following a plan exactly.
The conversations are training data for a small model that decides what an assistant should remember, so the
labels come from the plan and your text must match the plan precisely.

For every segment you receive a list of beats in order. Each beat says who speaks and what they must convey.
Write the segment as turns: consecutive beats by the same speaker form one turn. Keep the beats in order.

Tags. Each beat lists tags you must place in its text, written as [[TAG|text]]:
- "exact": the text inside the tag must be exactly the given string, character for character.
- "free": you choose the words inside the tag (for example a confirmation like "yes please", or the phrase
  naming what to forget), following the beat's instruction.
- Mention tags (m0, m1, ...) name a person or project in the way the beat specifies:
  full = role and name (e.g. "my sister Ayesha"); alias = name only or role only; pronoun = he/she/it (or
  his/her/him/its as the grammar needs).
- A tag written as u1+m0 marks one span that is both a unit and a mention.
Every listed tag must appear exactly once. Never add tags that are not listed.

Hard rules:
- Do not add any extra personal facts, preferences, plans or details about anyone. Small talk and filler words
  are fine; new facts are not, because they would be unlabelled.
- Never contradict the beat: a joke must read as a joke, a hypothetical as a hypothetical, a quote as someone
  else's words, a change as a change, a flat statement as a flat statement with no sign of change, an
  uncertain remark as undecided.
- When a beat says not to restate something (for example the earlier plan), do not restate it.
- Language: "en" English; "ur" Roman Urdu (Urdu written in Latin letters); "mixed" natural English/Roman Urdu
  code-mixing. Tag texts stay exactly as given even inside Urdu sentences.
- Keep turns short and natural, like real chat messages. Typos and casual style are fine outside tags.
- Assistant turns are brief and must not restate facts unless the beat says to answer.
Return only the JSON object described by the schema."""

SCHEMA = {
    "type": "object",
    "properties": {"segments": {"type": "array", "items": {
        "type": "object",
        "properties": {"index": {"type": "integer"}, "turns": {"type": "array", "items": {
            "type": "object", "properties": {"speaker": {"type": "string", "enum": ["user", "assistant"]}, "text": {"type": "string"}},
            "required": ["speaker", "text"], "additionalProperties": False}}},
        "required": ["index", "turns"], "additionalProperties": False}}},
    "required": ["segments"], "additionalProperties": False}


def describe(beat, world):
    """One plain-English instruction per beat (the realizer-independent plan)."""
    act, a, v = beat["act"], beat.get("attr"), None
    for t in beat["tags"]:
        if t["tag"].startswith("u"):
            v = t["text"]
    ent = beat.get("entity")
    who = "their own" if ent in (None, "user") else f"{world[ent]['text']}'s"
    old = beat.get("old")
    D = {
        "state": f"User states as a plain fact that {who} {a} is {v}.",
        "imply": f"User implies, without saying it outright, that {who} {a} is {v}.",
        "state_also": f"User says that {who} {a} is {v} too (the same as someone else's).",
        "repeat": f"User repeats, as a reminder and not as news, that {who} {a} is {v}.",
        "change": f"User says {who} {a} has changed to {v} (it used to be {old}); make the change explicit.",
        "contradict": f"User states flatly that {who} {a} is {v}. No sign of change, no mention of any earlier value.",
        "correct": f"User corrects an earlier mistake: {who} {a} is {v}, not {old}.",
        "joke": f"User jokes or is sarcastic, claiming their {a} is {v}; it must clearly be a joke.",
        "quote": f"User quotes somebody else's words that mention {v}; clearly someone else's words, not the user's view.",
        "uncertain": f"User is undecided, only considering {v} for their {a}.",
        "frame_open": f"User starts a hypothetical ('imagine...') in which their {a} would be {v}.",
        "frame_cont": f"User continues the earlier hypothetical: in that imagined world their {a} would be {v}. Do not restate the premise.",
        "frame_close": "User ends the hypothetical game and returns to reality.",
        "temp": f"User mentions a temporary situation or plan: '{v}'. Include the tag text verbatim.",
        "temp_update": f"User changes their earlier plan without restating it; the change is '{v}' verbatim.",
        "temp_done": "User says the earlier task or plan is done, without naming it.",
        "offer": f"Assistant asks whether it should remember that the user's {a} is {v}.",
        "confirm": "User agrees to the assistant's offer with a short confirmation (tag the confirmation, any wording).",
        "decline": "User declines the assistant's offer.",
        "forget": f"User asks the assistant to forget {who} {a}; tag the phrase naming what to forget (any wording).",
        "forget_profile": "User asks the assistant to forget everything about the person in the tag.",
        "ask": f"User asks what {who} {a} is. Do not state the value.",
        "merge_reveal": f"User explains that the person in the mention tag and the person they earlier called {beat.get('dup_text')} are the same person, then adds that their {a} is {v}.",
        "chitchat": "User makes small talk unrelated to anything worth remembering.",
        "ack": "Assistant acknowledges briefly.",
    }
    return D[act]


def episode_request(plan):
    world = plan["world"]
    segs = []
    for seg in plan["segments"]:
        if seg.get("real"):
            continue
        beats = []
        for b in seg["beats"]:
            d = describe(b, world)
            if b["act"] == "ack" and seg.get("answer"):
                d = f"Assistant answers the question: the value is {seg['answer']['value']}."
            tags = []
            for t in b["tags"]:
                kind = "exact" if t.get("exact", True) and t["tag"].startswith("u") else "free"
                tg = {"tag": t["tag"], "kind": kind}
                if kind == "exact":
                    tg["text"] = t["text"]
                if t["tag"].startswith("m"):
                    m = next(x for x in seg["mentions"] if x["tag"] == t["tag"])
                    tg["refers_to"] = world[m["entity"]]["text"]
                    tg["style"] = m["style"]
                    if m["style"] == "full":
                        tg["example"] = t["text"]
                tags.append(tg)
            if b["act"] == "forget_profile":                       # one span that is both unit and mention
                u = next(x for x in tags if x["tag"].startswith("u")); m = next(x for x in tags if x["tag"].startswith("m"))
                tags = [{"tag": f"{u['tag']}+{m['tag']}", "kind": "free", "refers_to": m["refers_to"], "style": m["style"]}]
            beats.append({"speaker": b["speaker"], "instruction": d, "tags": tags})
        segs.append({"index": seg["index"], "language": seg["lang"], "beats": beats})
    return {"segments": segs}


def params(plan, model, effort, max_tokens=7000):
    return {"model": model, "max_tokens": max_tokens, "system": SYSTEM, "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": SCHEMA}},
            "messages": [{"role": "user", "content": "Write this conversation.\n\n" + json.dumps(episode_request(plan), ensure_ascii=False)}]}


def merge_into_plan(plan, out):
    """Turn the API output into the realizer format; raises ValueError when the output breaks the plan."""
    by_index = {s["index"]: s for s in out["segments"]}
    realized = []
    for seg in plan["segments"]:
        if seg.get("real"):
            realized.append({"turns": [dict(t) for t in seg["beats"][0]["turns"]], "families": []}); continue
        got = by_index.get(seg["index"])
        if got is None:
            raise ValueError(f"segment {seg['index']} missing")
        turns, text, spans = assemble(got["turns"])
        need = {t["tag"] for b in seg["beats"] for t in b["tags"]}
        have = set(spans)
        if have != need:
            raise ValueError(f"segment {seg['index']}: tags {sorted(have)} != plan {sorted(need)}")
        for b in seg["beats"]:
            for t in b["tags"]:
                if t["tag"].startswith("u") and t.get("exact", True) and spans[t["tag"]][2] != t["text"]:
                    raise ValueError(f"segment {seg['index']}: exact tag {t['tag']} = {spans[t['tag']][2]!r}, plan {t['text']!r}")
        realized.append({"turns": got["turns"], "families": ["API"]})
    return realized


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["estimate", "run", "collect"])
    ap.add_argument("--plans", required=True)
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--effort", default="medium")
    ap.add_argument("--out")
    ap.add_argument("--max-usd", type=float, default=0.0)
    ap.add_argument("--batch-id")
    ap.add_argument("--max-tokens", type=int, default=7000, help="per-request output ceiling (thinking + JSON); bounds the worst-case cost")
    ap.add_argument("--output-tokens-per-episode", type=int, default=4000,
                    help="assumed output incl. thinking, for the estimate (measured in the run)")
    a = ap.parse_args()
    import anthropic
    client = anthropic.Anthropic()
    plans = [json.loads(l) for l in open(a.plans)]
    pin, pout = PRICES[a.model]
    if a.cmd == "estimate":
        tot = 0
        for p in plans:
            pr = params(p, a.model, a.effort)
            r = client.messages.count_tokens(model=pr["model"], system=pr["system"], messages=pr["messages"],
                                             output_config={"format": pr["output_config"]["format"]})
            tot += r.input_tokens
        out_tok = a.output_tokens_per_episode * len(plans)
        std = tot / 1e6 * pin + out_tok / 1e6 * pout
        print(json.dumps({"model": a.model, "episodes": len(plans), "input_tokens_total": tot,
                          "input_tokens_per_episode": round(tot / len(plans)), "assumed_output_tokens_total": out_tok,
                          "usd_standard": round(std, 2), "usd_batch_50pct": round(std / 2, 2)}, indent=1))
        return
    if a.cmd == "run":
        if a.max_usd <= 0:
            sys.exit("--max-usd is required (owner approval before any spend)")
        # Hard cap: refuse unless the worst case (every request uses its whole output budget) fits the approval.
        tot_in = 0
        for p in plans:
            pr = params(p, a.model, a.effort, a.max_tokens)
            tot_in += client.messages.count_tokens(model=pr["model"], system=pr["system"], messages=pr["messages"],
                                                   output_config={"format": pr["output_config"]["format"]}).input_tokens
        worst = (tot_in / 1e6 * pin + len(plans) * a.max_tokens / 1e6 * pout) / 2
        print(f"input tokens {tot_in}; worst-case batch cost ${worst:.2f} (cap ${a.max_usd:.2f})")
        if worst > a.max_usd:
            sys.exit("worst-case cost exceeds the approved cap; nothing submitted")
        from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
        from anthropic.types.messages.batch_create_params import Request
        reqs = [Request(custom_id=p["id"], params=MessageCreateParamsNonStreaming(**params(p, a.model, a.effort, a.max_tokens))) for p in plans]
        batch = client.messages.batches.create(requests=reqs)
        os.makedirs(a.out, exist_ok=True)
        json.dump({"batch_id": batch.id, "model": a.model, "effort": a.effort, "n": len(reqs), "max_usd": a.max_usd,
                   "max_tokens": a.max_tokens, "input_tokens_counted": tot_in, "worst_case_usd": round(worst, 2)},
                  open(os.path.join(a.out, "batch.json"), "w"))
        print(f"batch {batch.id} submitted ({len(reqs)} requests)")
        return
    # collect
    meta = json.load(open(os.path.join(a.out, "batch.json")))
    while True:
        b = client.messages.batches.retrieve(meta["batch_id"])
        if b.processing_status == "ended":
            break
        print(f"status {b.processing_status} {b.request_counts}", flush=True)
        time.sleep(30)
    plan_by_id = {p["id"]: p for p in plans}
    usage_in = usage_out = 0
    ok, fails = [], []
    raw = open(os.path.join(a.out, "raw.jsonl"), "w")
    for res in client.messages.batches.results(meta["batch_id"]):
        pid = res.custom_id
        if res.result.type != "succeeded":
            fails.append({"id": pid, "why": res.result.type}); continue
        msg = res.result.message
        usage_in += msg.usage.input_tokens; usage_out += msg.usage.output_tokens
        text = next((blk.text for blk in msg.content if blk.type == "text"), "")
        raw.write(json.dumps({"id": pid, "stop_reason": msg.stop_reason, "text": text}) + "\n")
        try:
            out = json.loads(text)
            plan = plan_by_id[pid]
            rz = merge_into_plan(copy.deepcopy(plan), out)
            ok.append(finalize(plan, rz, plan_by_id[pid]["id"].split("-")[0], f"api:{meta['model']}", pid))
        except Exception as e:  # noqa: BLE001 -- every failure is counted and reported
            fails.append({"id": pid, "why": str(e)[:300]})
    raw.close()
    cost = (usage_in / 1e6 * pin + usage_out / 1e6 * pout) / 2
    with open(os.path.join(a.out, "pilot-api.jsonl"), "w") as f:
        for ep in ok:
            f.write(json.dumps(ep, default=sorted) + "\n")
    json.dump({"ok": len(ok), "failed": len(fails), "failures": fails, "input_tokens": usage_in, "output_tokens": usage_out,
               "usd_batch": round(cost, 4)}, open(os.path.join(a.out, "collect.json"), "w"), indent=1)
    print(json.dumps({"ok": len(ok), "failed": len(fails), "input_tokens": usage_in, "output_tokens": usage_out, "usd_batch": round(cost, 4)}))


if __name__ == "__main__":
    main()
