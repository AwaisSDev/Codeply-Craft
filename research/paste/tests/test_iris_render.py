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
    assert "exactly 4 messages" in p and "'teal and coral'" in p and "no personal details" in p


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
