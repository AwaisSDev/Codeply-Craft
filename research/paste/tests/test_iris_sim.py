"""iris.sim.life: deterministic, split-disjoint, gold-consistent lives (IRIS-DESIGN §3.1)."""
import json

from iris import schema as S
from iris.sim.life import HOUR, GoldStore, Life


def _life(seed=0, split="pilot", days=14):
    return Life(seed, split, days).simulate()


def test_deterministic():
    assert json.dumps(_life(3)) == json.dumps(_life(3))


def test_split_disjoint_people():
    tr = {p["first"] for s in range(6) for p in _life(s, "train")["people"]}
    te = {p["first"] for s in range(6) for p in Life(s, "test", 14).simulate()["people"]}
    assert not tr & te


def test_gold_replay_and_targets():
    life = _life(1, days=21)
    g, seen = GoldStore(), set()
    for ev in life["events"]:
        for o in ev["gold"]["observations"]:
            if o["op"] in ("reinforce", "update", "contradict"):
                assert o["target"] in seen, o
            op, target, rid = g.observe(0, o["entity"], o["slot"], o["value"], o["kind"], o["certainty"], o["sensitivity"],
                                        o["sensitivity_category"], correction=o["op"] == "contradict")
            assert op == o["op"]
            if rid:
                seen.add(rid)
    assert {k: (m["entity"], m["slot"], m["value"]) for k, m in g.mem.items()} == \
           {k: (m["entity"], m["slot"], m["value"]) for k, m in life["final_memories"].items()}


def test_gold_observations_validate_against_schema():
    life = _life(2)
    for ev in life["events"]:
        obs = [{k: v for k, v in o.items() if not k.startswith("_") and v != ""} for o in ev["gold"]["observations"]]
        plans = [{k: p[k] for k in ("what", "when", "where", "who", "status")} for p in ev["gold"]["plans"]]
        errs = S.validate_extraction({"observations": obs, "plans": plans, "relations": []})
        assert not errs, (ev["event_id"], errs)


def test_fact_sheets_and_templates():
    life = _life(4)
    for ev in life["events"]:
        if ev["render"] == "llm":
            fs = ev["fact_sheet"]
            for m in fs["must_express"]:
                assert m["anchors"] and not set(m["anchors"]) & set(fs["must_not_contain"])
            for o in ev["gold"]["observations"]:
                assert any(o["value"] in m["anchors"] for m in fs["must_express"])
        else:
            assert ev["text"]


def test_conflict_tasks_and_rates():
    life = _life(5, days=21)
    assert any("gp" in c["plans"][0] for c in life["conflicts"])           # the injected 7 PM clash at least
    for c in life["conflicts"]:
        a, b = (life["final_plans"][p] for p in c["plans"])
        assert abs(a["when"] - b["when"]) < HOUR
    secret = {k for k, m in life["final_memories"].items() if m["sensitivity"] in ("secret", "private")}
    for t in life["tasks"]:
        assert set(t["forbidden"]) == secret and not set(t["needed"]) & secret - set(t["needed"])
    chats = [e for e in life["events"] if e["source"] == "assistant_chat"]
    rate = sum(len(e["gold"]["observations"]) for e in chats) / sum(e["fact_sheet"]["n_user_turns"] for e in chats)
    assert 0.06 <= rate <= 0.25
