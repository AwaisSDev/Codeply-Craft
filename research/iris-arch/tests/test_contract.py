from irisarch import contract as C

REQ = {"mode": "observe",
       "events": [{"id": "ev1", "source": "assistant_chat", "at": "2026-11-09T10:00", "text": "Quick update: the Atlas launch moved to January. Sara is handling the deck."},
                  {"id": "ev2", "source": "personal_chat", "at": "2026-11-09T11:00", "text": "lol imagine if we launched on Mars"}],
       "memories": [{"id": "m1", "kind": "decision", "slot": "atlas launch date", "value": "December", "text": "The Atlas launch is in December."}],
       "entities": [{"id": "e1", "name": "Atlas", "type": "project"}]}


def item(**kw):
    base = {"op": "update", "ref": "m1", "entity": {"id": "e1", "name": "Atlas", "type": "project"}, "about": "project",
            "kind": "decision", "attribute": "atlas launch date", "value": "January", "text": "The Atlas launch moved to January.",
            "certainty": "stated", "basis": "stated", "confidence": 0.93, "valid": {"from": "2026-11-09"},
            "privacy": {"level": "personal"}, "persist": "store", "reason": "launch date changed",
            "evidence": [{"event": "ev1", "quote": "the Atlas launch moved to January"}]}
    base.update(kw)
    return base


def test_good_update_is_admitted_and_bridges():
    out = {"v": "iris.v1", "mode": "observe", "items": [item()]}
    assert C.validate(out, REQ) == [] and C.verify_evidence(out, REQ) == []
    kept, rep = C.admit(out, REQ)
    assert rep["ok"] and len(kept["items"]) == 1
    assert C.to_v0(kept["items"][0])["op"] == "update"
    assert C.to_brain_observation(kept["items"][0])["slot"] == "atlas launch date"


def test_invented_quote_is_dropped():
    out = {"v": "iris.v1", "mode": "observe", "items": [item(evidence=[{"event": "ev1", "quote": "launch moved to February"}])]}
    kept, rep = C.admit(out, REQ)
    assert kept["items"] == [] and "quote not found" in rep["dropped"][0]["errors"][0]


def test_rules():
    errs = lambda **kw: C.validate({"v": "iris.v1", "mode": "observe", "items": [item(**kw)]}, REQ)  # noqa: E731
    assert any("needs ref" in e for e in C.validate({"v": "iris.v1", "mode": "observe", "items": [{k: v for k, v in item().items() if k != "ref"}]}, REQ))
    assert any("joking" in e for e in errs(certainty="joking"))
    assert any("secret" in e for e in errs(value="my password is hunter2", text="My password is hunter2."))
    assert any("inferred" in e for e in errs(basis="inferred", confidence=0.99))
    assert any("not ISO" in e for e in errs(valid={"from": "next week"}))
    assert any("unknown memory" in e for e in C.verify_evidence({"v": "iris.v1", "mode": "observe", "items": [item(ref="m9")]}, REQ))


def test_ignore_and_empty_are_valid():
    ign = {"op": "ignore", "evidence": [{"event": "ev2", "quote": "imagine if we launched on Mars"}], "basis": "stated",
           "confidence": 0.9, "persist": "ignore", "reason": "a joke, not a plan"}
    assert C.admit({"v": "iris.v1", "mode": "observe", "items": [ign]}, REQ)[1]["ok"]
    assert C.admit({"v": "iris.v1", "mode": "observe", "items": []}, REQ)[1]["ok"]
    assert C.to_brain_observation(ign) is None


def test_unparseable_admits_nothing():
    assert C.admit("Sure! Here are the memories: ...", REQ)[0] is None
    assert C.admit('```json\n{"v": "iris.v1", "mode": "observe", "items": []}\n```', REQ)[1]["ok"]
