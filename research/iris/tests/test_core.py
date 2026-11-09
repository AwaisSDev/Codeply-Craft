"""Unit tests for the Iris contract, guard, store, gold derivation and scoring.

    cd research/iris && python -m pytest tests -q
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "data"))

from codeply_iris import build, contract, metrics, prompt  # noqa: E402
from codeply_iris.store import MemoryStore, derive_ops, same_value, value_sim  # noqa: E402
import validate_raw  # noqa: E402


def demo():
    spec = (ROOT / "data" / "spec" / "TEACHER-SPEC.md").read_text()
    return json.loads(spec.split("## 5. Worked example")[1].split("```json")[1].split("```")[0])


ADD = {"src": 1, "evid": "im vegetarian", "op": "add", "ent": "user", "type": "user", "attr": "diet", "val": "vegetarian",
       "kind": "preference", "keep": "long", "basis": "stated", "conf": "high", "sens": "personal"}
MSGS = [{"who": "user", "text": "also im vegetarian so pls no steak"}, {"who": "assistant", "text": "Noted. You could try tofu."}]


def test_worked_example_is_valid():
    errors, warnings = validate_raw.check_episode(demo())
    assert errors == [] and warnings == []


def test_roundtrip_and_key_order():
    text = contract.dumps([ADD])
    parsed = contract.parse(text)
    assert parsed["ok"] and parsed["ops"] == [contract.order(ADD)]
    assert list(parsed["ops"][0])[:3] == ["src", "evid", "op"]          # evidence first, then the decision


def test_parse_rejects_malformed_and_invalid():
    assert contract.parse("not json")["ok"] is False and contract.parse("not json")["ops"] == []
    bad = dict(ADD, kind="nonsense")
    r = contract.parse(json.dumps({"ops": [bad, ADD]}))
    assert not r["ok"] and len(r["ops"]) == 1 and r["dropped"][0][1] == "bad_kind"
    assert contract.validate_op(dict(ADD, keep="temp"))[1] == "temp_without_until"
    assert contract.validate_op({"src": 1, "evid": "x y", "op": "update", "ref": "m1"})[1].startswith("missing_")
    assert contract.parse('prefix {"ops": []} suffix') == {"ok": False, "ops": [], "dropped": []}     # lenient, flagged


def test_guard_rejects_ungrounded_unknown_ref_assistant_and_secret():
    mems = [{"id": "m1", "ent": "user", "attr": "diet", "val": "vegan"}]
    ok, rej = contract.guard([ADD], MSGS, mems, "assistant_chat")
    assert len(ok) == 1 and not rej
    _, rej = contract.guard([dict(ADD, evid="I am a vegetarian")], MSGS, mems)
    assert rej[0][1] == "ungrounded_evidence"                              # paraphrased evidence is refused
    _, rej = contract.guard([{"src": 1, "evid": "im vegetarian", "op": "confirm", "ref": "m9"}], MSGS, mems)
    assert rej[0][1] == "unknown_ref"
    _, rej = contract.guard([dict(ADD, src=2, evid="You could try tofu")], MSGS, mems, "assistant_chat")
    assert rej[0][1] == "assistant_source"
    _, rej = contract.guard([dict(ADD, attr="wifi password", val="Tulip#9921x")], MSGS, mems)
    assert rej[0][1] == "secret"
    upd = {"src": 1, "evid": "im vegetarian", "op": "update", "ref": "m1", "ent": "Dana", "attr": "diet", "val": "vegetarian",
           "kind": "preference", "keep": "long", "why": "changed", "basis": "stated", "conf": "high", "sens": "personal"}
    _, rej = contract.guard([upd], MSGS, mems)
    assert rej[0][1] == "ref_entity_mismatch"


def test_value_equality():
    assert same_value("Finlo", "finlo.") and same_value("works at Finlo", "Finlo")
    assert not same_value("20 March 2026", "6 March 2026")                # digits differ
    assert not same_value("team offsite", "team offsite", "2026-03-06", "2026-03-20")
    assert value_sim("night of 19 March 2026", "19 March") >= 0.5


def test_derivation_depends_on_the_store():
    ep = demo()
    s2 = ep["sessions"][1]
    full = [{"id": "m5", "key": "f5", "ent": "Dubai design meetup", "attr": "date", "val": "6 March 2026", "when": "2026-03-06"}]
    ops = derive_ops(s2, full)
    assert [o["op"] for o in ops] == ["update", "skip", "add"] and ops[0]["ref"] == "m5" and ops[0]["why"] == "changed"
    ops = derive_ops(s2, [])                                              # the fact was missed earlier: now an add
    assert [o["op"] for o in ops] == ["add", "skip", "add"]
    same = [dict(full[0], val="20 March 2026", when="2026-03-20")]
    assert derive_ops(s2, same)[0]["op"] == "confirm"                     # already current: no new memory


def test_store_keeps_history_and_never_deletes():
    st = MemoryStore()
    row = st.apply(ADD, session=1, key="f4")
    upd = {"src": 1, "evid": "x", "op": "update", "ref": row["id"], "ent": "user", "attr": "diet", "val": "vegan", "kind": "preference",
           "keep": "long", "why": "changed", "basis": "stated", "conf": "high", "sens": "personal"}
    st.apply(upd, session=2)
    assert st.rows[row["id"]]["val"] == "vegan" and st.rows[row["id"]]["history"][0]["val"] == "vegetarian"
    st.apply({"src": 1, "evid": "x", "op": "retract", "ref": row["id"], "why": "user_request"}, session=3)
    assert st.live() == [] and row["id"] in st.rows and len(st.log) == 3   # retracted, audited, not erased


def test_scoring_perfect_and_false_memory():
    ep = demo()
    examples = build.build_split([ep], "val", seed=1)
    for ex in examples:
        if ex["task"] != "observe":
            continue
        pred = contract.parse(ex["target"])["ops"]
        ok, rej = contract.guard(pred, ex["messages"], ex["memories"], ex["source"])
        c, _ = metrics.score_observe(ok, ex["gold"], ex["memories"], rej)
        assert c["tp"] == c["gold_content"] == c["pred_content"] and c["false_memory"] == 0 and not rej
    ex = next(e for e in examples if e["task"] == "observe" and e["sid"] == 2)
    stored_rumour = {"src": 3, "evid": "suna hai Finlo layoffs kar raha hai", "op": "add", "ent": "Finlo", "type": "org", "attr": "layoffs",
                     "val": "laying people off", "kind": "fact", "keep": "long", "basis": "stated", "conf": "medium", "sens": "none"}
    c, _ = metrics.score_observe([stored_rumour], ex["gold"], ex["memories"])
    assert c["false_memory"] == 1 and c["false_from_skip"] == 1 and c["skip_stored"] == 1


def test_lookalike_entities_are_not_merged():
    assert metrics.resolve_entity("Nida", ["Nida", "Nida Raza"]) == "Nida"
    assert metrics.resolve_entity("Ali", ["Ali Raza", "Ali Khan"]) is None
    assert metrics.resolve_entity("Ali", ["Ali Raza", "Sara Khan"]) == "Ali Raza"


def test_prompt_format_is_stable():
    p = prompt.observe_prompt("2026-02-17T13:05", "personal_chat", [], [{"who": "user", "text": "hi\nthere"}])
    assert p == "TASK: observe\nNOW: 2026-02-17T13:05 Tue\nSOURCE: personal_chat\nMEMORIES:\n(none)\nINPUT:\n[1] user: hi there"
    assert prompt.chatml("x").endswith("<|im_start|>assistant\n")


def test_brain_mapping():
    b = contract.to_brain(ADD)
    assert b["action"] == "insert" and b["observation"]["kind"] == "preference" and b["observation"]["about"] == "user"
    assert contract.to_brain({"src": 1, "evid": "x", "op": "confirm", "ref": "m2"}) == {"action": "reinforce", "target": "m2"}
