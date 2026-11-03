"""Evaluator sanity: the gold oracle scores 1.0; omissions are recovered as WRITEs (closed-loop gold); spurious writes
are counted as false permanent memories. Episodes are generated on the fly (train split, throwaway seed)."""
import copy
import hashlib

import pytest

from data.build import finalize, make_plans
from data.realize_prog import ProgRealizer
from paste.evaluate import evaluate, oracle_propose


@pytest.fixture(scope="module")
def episodes():
    plans = make_plans("train", 40, seed=777)
    return [finalize(p, ProgRealizer("train", int(hashlib.sha256(p["id"].encode()).hexdigest()[:8], 16)).realize(copy.deepcopy(p)),
                     "train", "programmatic", p["id"]) for p in plans]


def test_oracle_is_perfect(episodes):
    s, _ = evaluate(episodes, oracle_propose)
    print("oracle", s["PE"], s["FPM_per_100_segments"])
    assert s["PE"] == 1.0 and s["FPM_per_100_segments"] == 0.0


def test_omissions_are_recovered(episodes):
    skipped = []

    def lossy(rep, seg, rows, state):
        ops, st = oracle_propose(rep, seg, rows, state)
        keep = []
        for o in ops:
            key = (seg["index"], o.get("payload", {}).get("value"), o["op"])
            if o["op"] == "WRITE" and int(hashlib.sha256(repr(key).encode()).hexdigest(), 16) % 5 == 0:
                skipped.append(key); continue
            keep.append(o)
        return keep, st
    s, _ = evaluate(episodes, lossy)
    w = s["per_op"]["WRITE"]
    print("lossy", s["PE"], w, "skipped", len(skipped))
    assert s["per_op"]["WRITE"]["fp"] == 0 and s["FPM_per_100_segments"] == 0.0
    assert w["fn"] == len(skipped)                     # exactly the skipped writes are missed ...
    assert s["per_op"]["UPDATE"]["fn"] == 0            # ... and later operations on them become recoverable WRITEs
    assert 0.8 < s["PE"] < 1.0


def test_spurious_writes_are_false_memories(episodes):
    def noisy(rep, seg, rows, state):
        ops, st = oracle_propose(rep, seg, rows, state)
        ops.append({"op": "WRITE", "entity": "user", "new_entity": False, "payload": {"attribute": "favourite colour",
                    "value": "ultraviolet", "certainty": "stated", "kind": "preference"}, "confidence": 0.1})
        return ops, st
    s, _ = evaluate(episodes, noisy)
    print("noisy", s["PE"], s["FPM_per_100_segments"])
    assert s["FPM_per_100_segments"] == 100.0 and s["recall"] == 1.0


def test_closed_loop_gold_equals_teacher_forced_on_identical_store(episodes, text):
    """At segment 0 the model's store equals the gold store, so closed-loop gold must equal teacher-forced gold."""
    from conftest import build_model
    from paste.adapter import PasteAdapter
    from paste.data import segment_gold
    from paste.evaluate import Replay
    ad = PasteAdapter(build_model(), text)
    for ep in episodes[:10]:
        _, g_tf = segment_gold(ad, ep["segments"][0])
        _, g_cl = segment_gold(ad, ep["segments"][0], Replay(ep))
        strip = lambda g: {k: v for k, v in g.items() if not k.startswith("_")}
        assert strip(g_tf) == strip(g_cl)
