"""iris.eval.extraction: matching, false memories, misattribution, non-storable, plans; oracle scores perfectly."""
from iris.eval.extraction import score_event, summarise
from iris.sim.life import Life


def _ev():
    return {"gold": {"observations": [
        {"entity": "user", "slot": "brand colours", "value": "teal and coral", "kind": "preference", "certainty": "stated", "op": "new", "sensitivity": "personal"},
        {"entity": "Sara Malik", "slot": "birthday", "value": "3 July", "kind": "fact", "certainty": "stated", "op": "update", "sensitivity": "personal"},
        {"entity": "user", "slot": "car", "value": "Tesla Model 3", "kind": "fact", "certainty": "hypothetical", "op": "none", "sensitivity": "personal"}],
        "plans": [{"what": "the investor meeting", "when": "2026-11-18T19:00", "status": "confirmed"}]}}


def test_scoring_cases():
    out = {"observations": [
        {"entity": "me", "slot": "brand colors", "value": "Teal and coral", "kind": "preference", "certainty": "stated", "op": "new", "sensitivity": "personal"},
        {"entity": "user", "slot": "birthday", "value": "3 July", "kind": "fact", "certainty": "stated", "op": "new", "sensitivity": "personal"},
        {"entity": "user", "slot": "car", "value": "Tesla Model 3", "kind": "fact", "certainty": "stated", "op": "new", "sensitivity": "personal"}],
        "plans": [{"what": "investor meeting", "when": "2026-11-18T19:30", "status": "tentative"}]}
    c = score_event(_ev(), out)
    assert c["tp"] == 1 and c["fp"] == 2 and c["fn"] == 1
    assert c["misattributed"] == 1 and c["stored_nonstorable"] == 1
    assert c["slot_ok"] == 1 and c["plan_tp"] == 1 and c["plan_status_ok"] == 0
    s = summarise([c], 1)
    assert s["false_memory_share"] == round(2 / 3, 4)


def test_gold_as_prediction_is_perfect():
    life = Life(3, "pilot", 14).simulate()
    cs = []
    for ev in life["events"]:
        out = {"observations": [{k: v for k, v in o.items() if not k.startswith("_")} for o in ev["gold"]["observations"]],
               "plans": ev["gold"]["plans"], "relations": []}
        cs.append(score_event(ev, out))
    s = summarise(cs, len(cs))
    assert s["f1"] == 1.0 and s["false_memory_share"] == 0.0 and s["on_matched"]["op"] == 1.0
    assert s["plans"]["recall"] == 1.0 and s["plans"]["status_acc_on_matched"] == 1.0
