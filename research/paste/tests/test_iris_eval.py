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


def test_pipeline_gold_vs_empty():
    from iris.eval.pipeline import score_life, summarise
    life = Life(5, "pilot", 21).simulate()
    gold_out = {ev["event_id"]: {"observations": [{k: v for k, v in o.items() if not k.startswith("_")} for o in ev["gold"]["observations"]],
                                 "plans": ev["gold"]["plans"], "relations": []} for ev in life["events"]}
    g = summarise([score_life(life, gold_out)])
    e = summarise([score_life(life, {})])
    assert g["state_accuracy"] == 1.0 and g["stale_rate"] == 0.0 and g["conflict_pairs_captured"] in (1.0, None)
    assert e["state_accuracy"] == 0.0 and e["task_context_recall"] in (0.0, None) and e["leaks"] == 0
    assert g["task_context_recall"] >= 0.5


def test_entity_named_in_slot_counts_for_that_person_and_temporary_capture():
    ev = {"gold": {"observations": [
        {"entity": "Komal Nawaz", "slot": "favourite colour", "value": "navy blue", "kind": "fact", "certainty": "stated", "op": "new", "sensitivity": "personal"},
        {"entity": "user", "slot": "bank", "value": "Standard Chartered", "kind": "fact", "certainty": "stated", "op": "new", "sensitivity": "personal"}],
        "plans": []}}
    out = {"observations": [
        {"entity": "user", "slot": "komal nawaz favorite colour", "value": "navy blue", "certainty": "implied", "kind": "fact"},
        {"entity": "user", "slot": "bank", "value": "Standard Chartered", "certainty": "temporary", "kind": "context"}], "plans": []}
    c = score_event(ev, out)
    assert c["tp"] == 1 and c["fn"] == 1 and c["captured_as_temporary"] == 1 and c["fp"] == 0


def test_production_request_matches_production_schema():
    """The prodprompt baseline sends production's strict schema (context-schema.js extractionJsonSchema) and 700 tokens."""
    import re
    from iris.baselines.production import PROD_MAX_TOKENS, PROD_SCHEMA
    src = open(__import__("os").path.join(__import__("os").path.dirname(__file__), "../../../codeply-cli/lib/context-schema.js")).read()
    assert f"MAX_OBSERVATIONS = {PROD_SCHEMA['properties']['observations']['maxItems']};" in src
    assert f"MAX_PLANS = {PROD_SCHEMA['properties']['plans']['maxItems']};" in src
    item = PROD_SCHEMA["properties"]["observations"]["items"]
    for k, n in (("slot", 60), ("value", 160), ("text", 240)):
        assert item["properties"][k]["maxLength"] == n and re.search(rf"{k}: {{ type: 'string', maxLength: {n} }}", src)
    model_src = open(__import__("os").path.join(__import__("os").path.dirname(__file__), "../../../codeply-cli/lib/context-model.js")).read()
    assert f"max_tokens: o.maxTokens || {PROD_MAX_TOKENS}" in model_src
