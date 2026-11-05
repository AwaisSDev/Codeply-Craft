"""iris.render: deterministic verifier and message plan (no model needed)."""
from iris.render.render import extra_forbidden, message_plan, prompt
from iris.render.verify import verify

EV = {"event_id": "ev9", "fact_sheet": {
    "source": "assistant_chat", "purpose": "The user asks for a packing list.", "participants": ["Emma", "assistant"],
    "n_user_turns": 4, "language": "en",
    "must_express": [{"speaker": "user", "how": "in passing", "anchors": ["teal and coral"],
                      "instruction": 'The user mentions their brand colours is "teal and coral"'}],
    "must_not_contain": ["navy and gold", "Bilal"]}}


def _turns(user_texts, extra=""):
    out = []
    for t in user_texts:
        out += [{"speaker": "user", "text": t}, {"speaker": "assistant", "text": "Sure, here is a helpful answer. " + extra}]
    return out


def test_verify_accepts_and_records_spans():
    ok, reasons, spans = verify(EV, _turns(["pack for 2 days", "my brand is Teal and Coral by the way", "thanks", "bye"]))
    assert ok, reasons
    assert spans[0]["turn"] == 2 and spans[0]["end"] - spans[0]["start"] == len("teal and coral")


def test_verify_rejects_missing_wrong_speaker_forbidden_and_counts():
    assert not verify(EV, _turns(["a", "b", "c", "d"]))[0]                                  # anchor missing
    t = _turns(["a", "b", "c", "d"]); t[1]["text"] += " teal and coral"
    assert "wrong speaker" in verify(EV, t)[1][0]                                           # said by the assistant
    assert any("forbidden" in r for r in verify(EV, _turns(["teal and coral", "b", "c", "d"], extra="Ask Bilal."))[1])
    assert any("user turns" in r for r in verify(EV, _turns(["teal and coral"]))[1])       # 1 < ceil(0.6 * 4)


def test_message_plan_and_prompt():
    n, plan = message_plan(EV, seed=1)
    assert n == 4 and sum(len(v) for v in plan.values()) == 1
    p = prompt(EV, seed=1)
    assert "exactly 4 messages" in p and "'teal and coral'" in p and "states no fact about" in p


def test_extra_forbidden_keeps_required_values():
    life = {"people": [{"name": "Bilal Khan"}, {"name": "Emma"}]}
    f = extra_forbidden(life, EV)
    assert "teal and coral" not in [x.lower() for x in f] and "navy and gold" in f and "Bilal" in f


def test_common_words_not_enforced():
    from iris.render.verify import distinctive
    assert not distinctive("Saturday") and not distinctive("weekends") and distinctive("Bilal") and distinctive("navy and gold")
    ev = dict(EV, fact_sheet=dict(EV["fact_sheet"], must_not_contain=["Saturday", "navy and gold"]))
    assert verify(ev, _turns(["teal and coral on Saturday", "b", "c", "d"]))[0]


def test_review_packets_blind_and_summary(tmp_path):
    import json
    from iris.render.review import packets, summarise
    from iris.sim.life import Life
    life = Life(7, "pilot", 7).simulate()
    lp = tmp_path / "l.jsonl"; lp.write_text(json.dumps(life) + "\n")
    evs = [e for e in life["events"] if e["render"] == "llm"][:4]
    for g in ("ga", "gb"):
        (tmp_path / f"{g}.jsonl").write_text("".join(json.dumps({"life_id": life["life_id"], "event_id": e["event_id"], "ok": True, "model": g,
                                                                  "turns": [{"speaker": "user", "text": "hi"}]}) + "\n" for e in evs))
    packets([("ga", f"{lp}:{tmp_path}/ga.jsonl"), ("gb", f"{lp}:{tmp_path}/gb.jsonl")], 3, 0, str(tmp_path / "out"))
    rows = [json.loads(l) for l in open(tmp_path / "out" / "packets.jsonl")]
    assert len(rows) == 6 and all("generator" not in json.dumps(r) and "ga" not in r["rid"] for r in rows)
    key = json.load(open(tmp_path / "out" / "key.json"))
    vp = tmp_path / "v.jsonl"
    vp.write_text("".join(json.dumps({"rid": r["rid"], "items_ok": [True], "contrary": [], "extra": ["x"] if key[r["rid"]]["generator"] == "gb" else []}) + "\n" for r in rows))
    summarise(str(tmp_path / "out" / "key.json"), [str(vp)], str(tmp_path / "s.json"))
    s = json.load(open(tmp_path / "s.json"))
    assert s["ga"]["meets_rule"] and not s["gb"]["meets_rule"] and s["gb"]["share_contrary_or_extra"] == 1.0


def test_meaning_gate_retries_and_reverify_keeps_rejection(tmp_path, monkeypatch):
    """A render that passes the exact verifier but fails the meaning gate is retried; a gate rejection survives reverify."""
    import json
    import iris.render.render as R
    import iris.render.meaning_check as M
    good = _turns(["My brand colours are teal and coral btw", "ok", "thanks", "great"])
    monkeypatch.setattr(R, "call", lambda *a, **k: (good, {"completion_tokens": 1}))
    verdicts = iter([{"items": [{"n": 0, "stated_with_this_meaning": True}], "extra_facts": ["I run marathons"]},
                     {"items": [{"n": 0, "stated_with_this_meaning": True}], "extra_facts": []}])
    monkeypatch.setattr(M, "check", lambda *a, **k: next(verdicts))
    res = R.render_event(EV, "x", "m", tries=3, check_url="y")
    assert res["ok"] and res["tries"] == 2
    verdicts = iter([{"items": [{"n": 0, "stated_with_this_meaning": False}], "extra_facts": []}] * 3)
    res = R.render_event(EV, "x", "m", tries=3, check_url="y")
    assert not res["ok"] and res["reasons"] == ["meaning: item 0 not faithful"]
    life = {"life_id": "L", "people": [], "projects": [], "events": [dict(EV, render="llm")]}
    (tmp_path / "l.jsonl").write_text(json.dumps(life) + "\n")
    (tmp_path / "r.jsonl").write_text(json.dumps({"life_id": "L", "event_id": "ev9", **res}) + "\n")
    import sys
    monkeypatch.setattr(sys, "argv", ["x", "--lives", str(tmp_path / "l.jsonl"), "--rendered", str(tmp_path / "r.jsonl"),
                                      "--out", str(tmp_path / "o.jsonl")])
    from iris.render import reverify
    reverify.main()
    assert json.loads((tmp_path / "o.jsonl").read_text())["ok"] is False


def test_prompt_v4_caps_free_messages():
    import iris.render.render as R
    R.STYLE["v"] = "v4"
    try:
        p = prompt(EV)
    finally:
        R.STYLE["v"] = "v3"
    assert "at most 15 words" in p and "30 to 70" in p and "at most 15 words" not in prompt(EV)


def test_plan_items_anchor_date_and_activity():
    """Plan items must state their date and activity verbatim, not just place and time (E59: bare 'Cafe X, 7:00 PM')."""
    from iris.sim.life import Life, day_anchor, what_anchor
    assert what_anchor("a study session") == "study session" and what_anchor("coffee") == "coffee"
    life = Life(103, "pilot", 21).simulate()
    plans = [m for ev in life["events"] if ev["render"] == "llm" for m in ev["fact_sheet"]["must_express"]
             if " on " in m["instruction"] and ("suggests" in m["instruction"] or "agrees to" in m["instruction"] or "proposes" in m["instruction"])]
    assert plans and all(any(a[0].isdigit() and " " in a for a in m["anchors"]) for m in plans)


def test_purposes_fact_neutral_and_rng_preserved():
    """E60: purposes of events without required facts must not imply memory-worthy facts; pool sizes are fixed so the
    simulator's random stream (and so the gold) does not change."""
    from iris.sim import pools as P
    assert len(P.ASSISTANT_PURPOSES) == 22 and len(P.CHAT_PURPOSES) == 10
    banned = ("weekend plans", "arranging a lift", "cover letter", "plan a weekend trip", "planning a birthday", "favour", "exam")
    assert not any(b in x for b in banned for x in P.ASSISTANT_PURPOSES + P.CHAT_PURPOSES)
