"""2026-11-03 fixes (DECISIONS): (1) evaluator: a NEW-ENT WRITE matches gold when the system's store lacks the gold
entity's profile (it missed the creating write); (2) training gold: such units become NEW-ENT with a mention target;
(3) profile-drop corruption removes one non-user profile. Validation data only (PASTE_DATA)."""
import os
import random

import pytest

from paste.data import corrupt_store
from paste.evaluate import Replay, execute, match_segment, oracle_propose
from paste.train import load_eps

DATA = os.environ.get("PASTE_DATA", os.path.expanduser("~/paste-data"))
VAL = os.path.join(DATA, "train", "val-programmatic.jsonl")
need = pytest.mark.skipif(not os.path.exists(VAL), reason="needs PASTE_DATA")


def _case(eps):
    """An episode with a new-entity WRITE of entity X, followed later by a WRITE about X whose unit names X."""
    for ep in eps:
        for i, s in enumerate(ep["segments"]):
            for g in s["gold_ops"]:
                if g["op"] == "WRITE" and g.get("new_entity"):
                    X = g["entity"]
                    for j in range(i + 1, len(ep["segments"])):
                        s2 = ep["segments"][j]
                        for g2 in s2["gold_ops"]:
                            u = next((u for u in s2["units"] if u["tag"] == g2.get("unit")), None)
                            if g2["op"] == "WRITE" and g2["entity"] == X and not g2.get("new_entity") and u and u.get("mention") is not None:
                                return ep, X, i, j
    return None


@need
def test_missed_profile_new_ent_write_matches():
    case = _case(load_eps([VAL])[:300])
    assert case, "no suitable val episode"
    ep, X, i, j = case
    rep, hits = Replay(ep), None
    for k, seg in enumerate(ep["segments"][:j + 1]):
        gold = rep.closed_loop_gold(seg)
        ops, _ = oracle_propose(rep, seg, rep.rows(), None)
        if k >= i:                                   # the system never learns about X: drop every op about X
            keep = []
            for p in ops:
                about_x = p["op"] == "WRITE" and (p["entity"] == X or p.get("new_entity"))
                if k == j and about_x and p["entity"] == X:
                    u = next(u for u in seg["units"] if u["tag"] == next(g["unit"] for g in gold if g["op"] == "WRITE" and g["entity"] == X))
                    ment = next(m["text"] for m in seg["mentions"] if m["tag"] == f"m{u['mention']}")
                    keep.append(dict(p, entity=None, new_entity=True, mention=ment))
                elif not about_x:
                    keep.append(p)
            ops = keep
        assert k < j or not rep.has_entity(X)
        tp, fp, fn, fw, pairs = match_segment(rep, seg, ops, gold)
        if k == j:
            hits = [p for p, g in pairs if p.get("new_entity") and g["entity"] == X]
        execute(rep, ops, pairs)
    assert hits, "NEW-ENT write about a profile the system never created must match"


@need
def test_profile_drop_corruption():
    ep = next(e for e in load_eps([VAL])[:50] if len({r["entity"] for r in e["segments"][1]["store_before"]} - {"user"}) >= 2)
    seg = ep["segments"][1]
    out = corrupt_store(seg, random.Random(0), p_prof=1.0)
    before = {r["entity"] for r in seg["store_before"]} - {"user"}
    after = {r["entity"] for r in out["store_before"]} - {"user"}
    assert len(after) == len(before) - 1
    assert corrupt_store(seg, random.Random(0))["store_before"] == seg["store_before"]
