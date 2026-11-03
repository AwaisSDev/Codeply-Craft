"""Gold-store corruption (paste.data.corrupt_store): relabelling through provenance stays consistent."""
import json
import os
import random

import pytest

from paste.adapter import PasteAdapter
from paste.config import PasteConfig
from paste.data import corrupt_store, segment_gold

VAL = os.path.join(os.environ.get("PASTE_DATA", os.path.expanduser("~/paste-data")), "train", "val-programmatic.jsonl")


@pytest.fixture(scope="module")
def setup():
    if not os.path.exists(VAL):
        pytest.skip("validation data not present")
    from paste.modernbert import ettin_files
    from paste.text import Text
    from paste.train import make_model
    cfg = PasteConfig(head_norm=True)
    text = Text(ettin_files(cfg.backbone)[1])
    m = make_model("PASTE", cfg, text)
    eps = [json.loads(l) for _, l in zip(range(3), open(VAL))]
    return PasteAdapter(m, text), eps


def test_drop_all_turns_record_targets_into_new(setup):
    """Empty store: only the always-present `user` profile remains, so a target about the user becomes
    NEW-ATTR(user) (index 0) and every other target NEW-ENT (index E); no relation label survives."""
    ad, eps = setup
    rng = random.Random(0)
    checked = 0
    for ep in eps:
        for seg in ep["segments"]:
            c = corrupt_store(seg, rng, p_del=1.0)
            assert c["store_before"] == []
            s_in, gold = segment_gold(ad, c)
            E = len(s_in.profiles)
            assert E == 1
            for g in gold["units"]:
                if "omega" not in g or g["route"] != "PERSIST":
                    continue
                assert g["omega"] in (0, E)
                assert "rel" not in g
                checked += 1
    assert checked > 0


def test_spurious_record_is_never_a_target(setup):
    ad, eps = setup
    rng = random.Random(1)
    pool = [r for ep in eps for sg in ep["segments"] for r in sg["store_before"]]
    seen = 0
    for ep in eps:
        for seg in ep["segments"]:
            c = corrupt_store(seg, rng, p_ins=1.0, pool=pool)
            ids = [r["id"] for r in c["store_before"]]
            if not any(i.startswith("spurious") for i in ids):
                continue
            seen += 1
            j = next(k for k, i in enumerate(ids) if i.startswith("spurious"))
            _, gold = segment_gold(ad, c)
            _, gold0 = segment_gold(ad, seg)
            assert all(u.get("omega") != j for u in gold["units"])
            assert len(gold["units"]) == len(gold0["units"])
            assert len(c["store_before"]) == len(seg["store_before"]) + 1
    assert seen > 0


def test_no_corruption_is_identity(setup):
    ad, eps = setup
    seg = eps[0]["segments"][5]
    assert corrupt_store(seg, random.Random(0))["store_before"] == seg["store_before"]
