"""T2: with the prefix fully masked, PASTE's segment states equal the plain encoder's.
T3: permutation equivariance over records, profiles and temporary items (spec tol 1e-5)."""
import copy
import random

import torch

from conftest import STORE, T0, seg


def _input(adapter, st=None, store=STORE, s=None):
    st = st or adapter.empty_state()
    s_in, text, offs, pm = adapter.build(s or seg("My sister Ayesha moved to Lahore last week, and I switched to green tea."), store, st)
    return s_in, text, offs, pm


def _with_temps(adapter, n=3):
    st = adapter.empty_state()
    g = torch.Generator().manual_seed(3)
    texts = ["call the bank at 3pm", "imagine I lived in Paris", "should I remember that you like jazz?"]
    for i in range(n):
        st["items"].append({"id": f"t{i}", "type": ["TASK", "FRAME", "PENDING"][i], "ttl": "SESSION", "until": None,
                            "created_at": T0, "created_seg": 0, "text": texts[i], "z": torch.randn(adapter.m.cfg.d, generator=g)})
    st["seg_index"] = 2
    return st


def test_t02_masked_prefix_equals_encoder(adapter):
    m = adapter.m
    s_in, *_ = _input(adapter, _with_temps(adapter))
    with torch.no_grad():
        masked = m.encode([s_in], prefix_masked=True)[0].seg
        plain = m.enc.encode_ids(torch.tensor([s_in.seg_ids]))[0]
        # same prefix sizes, different prefix contents (random h) -> must be bitwise identical when masked
        s_in2 = copy.copy(s_in); s_in2.h = torch.randn(m.cfg.r_mem, m.cfg.d)
        masked2 = m.encode([s_in2], prefix_masked=True)[0].seg
    d = (masked - plain).abs().max().item()
    print(f"T2 masked-prefix vs plain encoder: max|diff| {d:.2e} (max|h| {plain.abs().max():.1f}); prefix-content change: {(masked - masked2).abs().max().item():.2e}")
    assert torch.equal(masked, masked2), "masked prefix content leaked into segment states"
    assert d < 1e-4


def _permutation_diffs(adapter, m):
    st = _with_temps(adapter)
    dt = next(m.parameters()).dtype
    for it in st["items"]:
        it["z"] = it["z"].to(dt)
    s_in, *_ = _input(adapter, st)
    random.seed(0)
    rp, pp, tp = list(range(len(s_in.records))), list(range(1, len(s_in.profiles))), list(range(len(s_in.temps)))
    random.shuffle(rp); random.shuffle(pp); random.shuffle(tp)
    pmap = [0] + pp                      # new profile i = old profile pmap[i]; user stays first
    inv = {old: new for new, old in enumerate(pmap)}
    s2 = copy.copy(s_in)
    s2.profiles = [s_in.profiles[o] for o in pmap]
    s2.records = [copy.copy(s_in.records[o]) for o in rp]
    for r in s2.records:
        r.prof = inv[r.prof]
    s2.temps = [s_in.temps[o] for o in tp]
    with torch.no_grad():
        a, b = m.encode([s_in])[0], m.encode([s2])[0]
        span = (3, 8)
        ua, ub = m.unit_outputs(a, span, src=-1), m.unit_outputs(b, span, src=-1)
    diffs = {
        "records (att)": (a.att[rp] - b.att).abs().max().item(),
        "records (val)": (a.val[rp] - b.val).abs().max().item(),
        "profiles": (a.prof[pmap] - b.prof).abs().max().item(),
        "temporary items": (a.tmp[tp] - b.tmp).abs().max().item(),
        "segment tokens": (a.seg - b.seg).abs().max().item(),
        "memory tokens": (a.mem - b.mem).abs().max().item(),
        "unit gate logit": (ua["gate"] - ub["gate"]).abs().item(),
    }
    K, E = len(rp), len(pmap)
    omega_perm = rp + [K + o for o in pmap] + [K + E]
    diffs["address log-probs"] = (ua["addr"][omega_perm] - ub["addr"]).abs().max().item()
    T = len(tp)
    diffs["temporary address"] = (ua["tmp"][tp + [T]] - ub["tmp"]).abs().max().item()
    return diffs, a.seg.abs().max().item()


DECISIONS = ("unit gate logit", "address log-probs", "temporary address")


def test_t03_fp32_spec_tolerance_report(adapter):
    """Spec T3 as written (fp32, 1e-5 absolute). Clarification C3: fp32 states differ by summation order
    (~1.5e-5 at |h| ~ 41). Decision outputs are held to 1e-5; hidden states to 1e-6 relative to max|h|."""
    diffs, hmax = _permutation_diffs(adapter, adapter.m)
    for k, v in diffs.items():
        print(f"T3 fp32 {k}: max|diff| {v:.2e}")
    assert max(diffs[k] for k in DECISIONS) < 1e-5, diffs
    assert max(v for k, v in diffs.items() if k not in DECISIONS) < 1e-6 * hmax, diffs


def test_t03_fp64_exact_equivariance(text):
    """The property itself: in float64 the permuted outputs must agree to 1e-10 (rounding only)."""
    from conftest import build_model
    from paste.adapter import PasteAdapter
    prev = torch.get_default_dtype()
    torch.set_default_dtype(torch.float64)
    try:
        m = build_model(perturb=True).double()
        diffs, _ = _permutation_diffs(PasteAdapter(m, text), m)
    finally:
        torch.set_default_dtype(prev)
    for k, v in diffs.items():
        print(f"T3 fp64 {k}: max|diff| {v:.2e}")
    assert max(diffs.values()) < 1e-10, diffs
