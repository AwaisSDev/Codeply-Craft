"""The builder turns simulated lives into iris.v1 examples whose gold always passes the contract."""
import random

from iris.sim import life as L
from irisarch import build as B
from irisarch import checks as K


def _life(split="train", seed=10011, days=14):
    import argparse, io, json, contextlib, tempfile, os
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "l.jsonl")
        import sys
        argv, sys.argv = sys.argv, ["life", "--split", split, "--n", "1", "--out", out, "--seed", str(seed), "--days", str(days)]
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                L.main()
        finally:
            sys.argv = argv
        return json.loads(open(out).readline())


def test_every_gold_passes_the_contract():
    life = _life()
    obs, st = B.observe_examples(life, random.Random(1), noise=0.5, plain=True)
    ret = B.retrieve_examples(life, random.Random(1))
    assert obs and st["events"] == len(life["events"])
    for ex in obs + ret:
        assert B.check(ex) == [], ex["id"]


def test_doing_nothing_is_taught():
    obs, _ = B.observe_examples(_life(seed=10012), random.Random(2), plain=True)
    empty = [e for e in obs if not (e["gold"]["items"] or e["gold"]["plans"] or e["gold"]["relations"])]
    assert len(empty) > len(obs) * 0.2


def test_updates_point_at_the_existing_memory():
    obs, _ = B.observe_examples(_life(seed=10013, days=21), random.Random(3), plain=True)
    ups = [(e, i) for e in obs for i in e["gold"]["items"] if i["op"] in ("update", "reinforce", "correct")]
    assert ups
    for e, i in ups:
        mem = {m["id"]: m for m in e["request"]["memories"]}[i["ref"]]
        assert mem["slot"] == i["attribute"]


def test_plain_renders_are_refused_for_real_sets(tmp_path):
    obs, _ = B.observe_examples(_life(seed=10014), random.Random(4), plain=True)
    p = tmp_path / "x.jsonl"
    p.write_text("\n".join(__import__("json").dumps(e) for e in obs))
    _, failures = K.run([str(p)])
    assert any("plain render" in f for f in failures)
