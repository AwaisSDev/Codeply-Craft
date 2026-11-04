"""iris.schema: production-compatible cleaning (ported from brain.js), validation, Brain conversion."""
import os
import re

from iris import schema as S

BRAIN = os.path.join(os.path.dirname(__file__), "..", "..", "..", "codeply-cli", "lib", "brain.js")


def test_constants_match_production_source():
    """Read-only check that the ports still match brain.js (fails loudly if production changes)."""
    if not os.path.exists(BRAIN):
        return
    src = open(BRAIN).read()
    kinds = re.findall(r"^\s{2}(\w+): \{ label:", src, re.M)
    assert tuple(kinds) == S.KINDS
    cert = re.search(r"const CERTAINTY = \[([^\]]+)\]", src).group(1)
    assert tuple(x.strip(" '") for x in cert.split(",")) == S.CERTAINTY
    assert "card number|iban|ssn)" in src and "sk-[a-z0-9]{8,}" in src


def test_clean_observation_port():
    c = S.clean_observation({"kind": "Preferences", "slot": "Favourite  Colour!", "value": " teal ", "certainty": "explicit"})
    assert c["kind"] == "preference" and c["slot"] == "favourite colour" and c["value"] == "teal" and c["certainty"] == "stated"
    assert c["text"] == "favourite colour: teal"
    c = S.clean_observation({"kind": "now", "text": "in Lahore this week", "certainty": "stated"})
    assert c["kind"] == "context" and c["certainty"] == "temporary"
    c = S.clean_observation({"kind": "fact", "text": "works at Atlas", "certainty": "temporary"})
    assert c["kind"] == "context"
    assert S.clean_observation({"kind": "fact", "text": "ok"}) is None
    assert S.clean_observation({"kind": "weird", "text": "launch on Friday", "project": "Iris"})["kind"] == "decision"
    assert S.brain_would_store({"kind": "fact", "text": "my card number is 4111", "certainty": "stated"}) == "ignored"
    assert S.brain_would_store({"kind": "fact", "text": "I would love a Tesla", "certainty": "maybe"}) == "ignored"


def _obs(**k):
    o = {"kind": "fact", "slot": "employer", "value": "Atlas Labs", "text": "The user works at Atlas Labs.", "certainty": "stated",
         "importance": 0.7, "about": "user", "entity": "user", "op": "new", "sensitivity": "personal"}
    o.update(k)
    return o


def test_validate_extraction_rules():
    ok = {"observations": [_obs()], "plans": [{"what": "investor meeting", "when": "2026-11-10T19:00", "status": "confirmed"}],
          "relations": [{"a": "user", "relation": "investor", "b": "Sara Malik"}]}
    assert S.validate_extraction(ok) == []
    bad = {"observations": [_obs(op="update"), _obs(about="person", kind="preference"), _obs(value="password hunter2")],
           "plans": [], "relations": []}
    errs = S.validate_extraction(bad)
    assert any("needs a target" in e for e in errs) and any("must be 'fact'" in e for e in errs) and any("not labelled secret" in e for e in errs)
    assert S.validate_extraction({"observations": [_obs(extra=1)], "plans": [], "relations": []})
    assert S.validate_extraction({"observations": [], "plans": [{"what": "x", "status": "maybe"}], "relations": []})


def test_brain_conversion_drops_research_fields():
    b = S.to_brain_observation(_obs(project="", until=""))
    assert set(b) == {"kind", "text", "slot", "value", "certainty", "scope"}
    row = S.to_brain_row({"id": "m1", "kind": "fact", "scope": "me", "text": "t", "locked": True, "sensitivity": "secret", "entity": "x"})
    assert tuple(row) == S.BRAIN_COLUMNS and row["locked"] == 1 and "sensitivity" not in row
