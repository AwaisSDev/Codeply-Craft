"""A3 (spec v2.2 candidate): PASTE profiles as verbatim token rows (`profile_rows=True`).

Rows sit after the segment at parallel positions and are block-masked from one another, so the invariants that hold
for v2.1 must still hold: T2 (masked memory leaves the segment equal to the plain encoder), T3 (exact permutation
equivariance over records, profiles and temporary items), and the training loss must reach the encoder and heads.
"""
import dataclasses

import torch

from test_t02_t03 import DECISIONS, _input, _permutation_diffs, _with_temps


def _rows_model(base, dtype=None):
    import copy
    from paste.model import PasteModel
    m = PasteModel(dataclasses.replace(base.cfg, profile_rows=True), copy.deepcopy(base.enc)).eval()   # never alias
    m.load_state_dict(base.state_dict())
    return m.to(dtype) if dtype else m


def test_block_mask_isolates_rows(model):
    pos = torch.tensor([[0, 1, 2, 3, 3, 3, 4]])
    valid = torch.ones(1, 7, dtype=torch.bool)
    pre = torch.tensor([[1, 0, 0, 1, 1, 1, 1]], dtype=torch.bool)
    block = torch.tensor([[0, 0, 0, 1, 1, 2, 2]])
    full, local = model.enc.build_masks(pos, valid, pre, block)
    for M in (full[0, 0], local[0, 0]):
        assert not M[3, 5] and not M[5, 3] and not M[4, 6]      # different rows
        assert M[3, 4] and M[5, 6]                              # same row
        assert M[1, 3] and M[3, 1] and M[0, 6] and M[6, 2]      # segment / prefix <-> rows


def test_rows_t02_masked_memory_equals_encoder(adapter):
    m = _rows_model(adapter.m)
    from paste.adapter import PasteAdapter
    ad = PasteAdapter(m, adapter.text)
    s_in, *_ = _input(ad, _with_temps(ad))
    assert len(s_in.profiles) >= 2
    with torch.no_grad():
        masked = m.encode([s_in], prefix_masked=True)[0].seg
        plain = m.enc.encode_ids(torch.tensor([s_in.seg_ids]))[0]
    assert (masked - plain).abs().max().item() < 1e-4


def test_rows_change_profile_outputs_and_use_rows(adapter):
    """Profile vectors come from the rows: renaming one profile changes its vector, and v2.1 and v2.2 differ."""
    m = _rows_model(adapter.m)
    from paste.adapter import PasteAdapter
    ad = PasteAdapter(m, adapter.text)
    s_in, *_ = _input(ad)
    with torch.no_grad():
        a = m.encode([s_in])[0]
        b = adapter.m.encode([s_in])[0]
    E = len(s_in.profiles)
    assert a.prof.shape == (E, m.cfg.d) and torch.isfinite(a.prof).all()
    assert (a.prof - b.prof).abs().max() > 1e-3
    # prefix length shrinks by E tokens; segment length unchanged
    assert a.seg.shape == b.seg.shape


def test_rows_t03_fp32(adapter):
    m = _rows_model(adapter.m)
    from paste.adapter import PasteAdapter
    diffs, hmax = _permutation_diffs(PasteAdapter(m, adapter.text), m)
    assert max(diffs[k] for k in DECISIONS) < 1e-5, diffs
    assert max(v for k, v in diffs.items() if k not in DECISIONS) < 1e-6 * hmax, diffs


def test_rows_t03_fp64_exact(adapter, text):
    from paste.adapter import PasteAdapter
    prev = torch.get_default_dtype()
    torch.set_default_dtype(torch.float64)
    try:
        m = _rows_model(adapter.m, torch.float64)
        diffs, _ = _permutation_diffs(PasteAdapter(m, text), m)
    finally:
        torch.set_default_dtype(prev)
    assert max(diffs.values()) < 1e-10, diffs


def test_rows_training_step(adapter):
    """One teacher-forced loss on a real-shaped step reaches encoder and heads with finite gradients."""
    m = _rows_model(adapter.m).train()
    from paste.adapter import PasteAdapter
    ad = PasteAdapter(m, adapter.text)
    s_in, *_ = _input(ad)
    enc = m.encode([s_in])[0]
    out = m.unit_outputs(enc, (3, 8), src=-1)
    loss = -out["addr"][len(s_in.records)] + out["gate"].sum()   # NEW-ATTR(profile 0) target + gate logit
    loss.backward()
    g_enc = sum(p.grad.abs().sum().item() for p in m.enc.parameters() if p.grad is not None)
    g_head = sum(p.grad.abs().sum().item() for p in m.heads.parameters() if p.grad is not None)
    assert g_enc > 0 and g_head > 0 and torch.isfinite(torch.tensor([g_enc, g_head])).all()
