"""Baselines: parameter counts equal tools/param_count.py, they run through the same adapter, and M1c's outputs do
not depend on row order in eval mode (rows are only shuffled in training)."""
import copy
import importlib.util
import os

import pytest
import torch

from conftest import STORE, T0, seg
from paste.adapter import PasteAdapter
from paste.baselines import build
from paste.config import PasteConfig
from paste.modernbert import load_backbone
from test_t02_t03 import _with_temps

SPEC = {"M1c": 36_418_838, "M1c-m": 39_074_966, "RMT": 36_568_214, "M1c+W": 36_418_838, "FC": 36_418_838, "KV": 36_862_358}


@pytest.fixture(scope="module")
def backbone():
    return load_backbone(PasteConfig())


@pytest.mark.parametrize("name", list(SPEC))
def test_baseline_params_and_run(name, backbone, text):
    torch.manual_seed(0)
    m = build(name, PasteConfig(), copy.deepcopy(backbone), text).eval()
    n = sum(p.numel() for p in m.parameters())
    print(f"{name}: {n:,} parameters (spec {SPEC[name]:,})")
    assert n == SPEC[name]
    ad = PasteAdapter(m, text)
    st = ad.serialize(_with_temps(ad) | {"session_id": "s1", "last_at": T0 - 60})
    out = None
    for i, txt in enumerate(["My sister Ayesha moved to Lahore.", "make that 5pm", "Please forget my diet."]):
        out = ad.step(seg(txt, at=T0 + 60 * i), STORE, st)
        st = out["temp_state"]
    assert "operations" in out
    if name in ("M1c+W", "FC"):
        assert len(st["history"]) == 3
    else:
        assert "history" not in st


def test_m1c_eval_independent_of_row_order(backbone, text):
    m = build("M1c", PasteConfig(), copy.deepcopy(backbone), text).eval()
    ad = PasteAdapter(m, text)
    s_in, *_ = ad.build(seg("My sister Ayesha moved to Lahore."), STORE, ad.empty_state())
    with torch.no_grad():
        a = m.encode([s_in])[0]
        torch.manual_seed(5)
        b = m.encode([s_in])[0]
    assert torch.equal(a.att, b.att) and torch.equal(a.seg, b.seg)


def test_flat_address_is_a_distribution(text):
    from conftest import build_model
    m = build_model()
    m.cfg.flat_address = True
    try:
        ad = PasteAdapter(m, text)
        s_in, *_ = ad.build(seg("My sister Ayesha moved to Lahore."), STORE, ad.empty_state())
        enc = m.encode([s_in])[0]
        with torch.no_grad():
            lp = m.unit_outputs(enc, (3, 8), src=-1)["addr"]
        assert lp.shape[0] == len(STORE) + enc.prof.shape[0] + 1 and abs(torch.logsumexp(lp, 0).item()) < 1e-5
    finally:
        m.cfg.flat_address = False
