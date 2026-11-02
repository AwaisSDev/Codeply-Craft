"""S1 (component check, not one of T1-T12): the losses train. A three-segment toy episode with teacher forcing
must be over-fitted, and gradients must reach the encoder, the heads and every memory-pathway module,
including through h across segments (truncated BPTT)."""
import time

import torch

from conftest import STORE, T0, build_model, seg
from paste.adapter import PasteAdapter
from paste.config import ATTRS, CERTS, KINDS, RELS, TTLS, TTYPES
from paste.losses import episode_loss
from paste.model import TempIn


def _gold(adapter, text_user, units, ments=()):
    s = seg(text_user)
    st = adapter.empty_state()
    s_in, text, offs, pm = adapter.build(s, STORE, st)
    n = len(s_in.seg_ids)
    bio, ebio = [0] * n, [0] * n
    out = []
    for u in units:
        a = text.index(u["text"]); b = a + len(u["text"])
        ts, te = adapter.text.char_to_token_span(offs, a, b)
        bio[ts] = 1
        for i in range(ts + 1, te): bio[i] = 2
        out.append({**u, "span": (ts, te)})
    mspans = []
    for mt in ments:
        a = text.index(mt); ts, te = adapter.text.char_to_token_span(offs, a, a + len(mt))
        ebio[ts] = 1
        for i in range(ts + 1, te): ebio[i] = 2
        mspans.append((ts, te))
    return s, {"unit_bio": bio, "ent_bio": ebio, "units": out, "ment_spans": mspans,
               "retrieve": [1 if r["id"] == "m2" else 0 for r in STORE], "merge_pos": []}


def toy_episode(adapter):
    K, E = len(STORE), 3
    s1, g1 = _gold(adapter, "My sister Ayesha moved to Lahore.", [dict(text="Lahore", route="PERSIST", kind=KINDS.index("fact"),
              cert=CERTS.index("stated"), attr=ATTRS.index("home city"), src=-1, omega=1, rel=RELS.index("UPDATE"))], ["sister Ayesha"])
    s2, g2 = _gold(adapter, "I'm calling the bank at 3pm today.", [dict(text="calling the bank at 3pm", route="TEMP", kind=KINDS.index("context"),
              cert=CERTS.index("temporary"), attr=ATTRS.index("OTHER"), ttype=TTYPES.index("TASK"), ttl=TTLS.index("UNTIL"), tmp=0)])
    s3, g3 = _gold(adapter, "Actually make that 5pm.", [dict(text="5pm", route="TEMP", kind=KINDS.index("context"),
              cert=CERTS.index("temporary"), attr=ATTRS.index("OTHER"), ttype=TTYPES.index("TASK"), ttl=TTLS.index("UNTIL"), tmp=0)])
    g3["expire"] = [0]
    # Segment 4 reads the item GRU_T updated in segment 3 (first run of this test: without it GRU_T's output
    # never reached a loss, so its gradient was correctly zero) and closes it.
    s4, g4 = _gold(adapter, "Done, they fixed my card.", [])
    g4["expire"] = [1]
    item_ids, item_idx = adapter.text.span("calling the bank at 3pm")

    def maker(s, n_items):
        def make(h, zs):
            s_in, *_ = adapter.build(s, STORE, adapter.empty_state())
            s_in.h = h
            s_in.temps = [TempIn(item_ids, item_idx, zs[i], TTYPES.index("TASK"), 0) for i in range(n_items)]
            return s_in
        return make
    return [{"make": maker(s1, 0), "gold": g1, "session_start": True},
            {"make": maker(s2, 0), "gold": g2, "temp_ops": [("NEW", 0)]},
            {"make": maker(s3, 1), "gold": g3, "temp_ops": [("UPDATE", 0, 0)]},
            {"make": maker(s4, 1), "gold": g4, "temp_ops": [("DROP", 0)]}]


def test_s1_gradients_and_overfit(text):
    torch.manual_seed(0)
    m = build_model()                       # spec initialisation (zero-init pathway), not perturbed
    m.train()
    ad = PasteAdapter(m, text); m.train()
    ep = toy_episode(ad)
    loss, terms = episode_loss(m, ep)
    loss.backward()
    def gnorm(mod):
        ps = [p.grad for p in (mod.parameters() if hasattr(mod, "parameters") else [mod]) if p.grad is not None]
        return sum(float(g.norm()) for g in ps)
    g0 = {"encoder": gnorm(m.enc), "heads": gnorm(m.heads), "W_h": gnorm(m.W_h), "W_z": gnorm(m.W_z),
          "W_att": gnorm(m.W_att), "gru_h": gnorm(m.gru_h), "gru_t": gnorm(m.gru_t), "W_new": gnorm(m.W_new), "h0": gnorm(m.h0)}
    print("S1 step-0 gradient norms:", {k: f"{v:.2e}" for k, v in g0.items()})
    for k in ("encoder", "heads", "W_h", "W_z", "W_att"):
        assert g0[k] > 0, k
    # Expected and documented: with zero-initialised W_h / W_z, h and the item vectors do not yet reach the
    # outputs, so GRU_H, GRU_T and W_new receive zero gradient at step 0; they must after the first update.
    opt = torch.optim.AdamW([{"params": m.enc.parameters(), "lr": 5e-5},
                             {"params": list(m.heads.parameters()) + m.memory_pathway_parameters(), "lr": 5e-4}])
    opt.step(); opt.zero_grad()
    loss1, _ = episode_loss(m, ep); loss1.backward()
    g1 = {"gru_h": gnorm(m.gru_h), "gru_t": gnorm(m.gru_t), "W_new": gnorm(m.W_new)}
    print("S1 step-1 gradient norms:", {k: f"{v:.2e}" for k, v in g1.items()})
    assert all(v > 0 for v in g1.values()), g1
    opt.step(); opt.zero_grad()
    first = float(loss)
    t = time.perf_counter()
    for i in range(40):
        loss, terms = episode_loss(m, ep)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)          # spec §6.5
        opt.step(); opt.zero_grad()
    dt = (time.perf_counter() - t) / 40
    print(f"S1 loss {first:.3f} -> {float(loss):.3f} after 42 steps; {dt*1000:.0f} ms per 4-segment step (CPU, 4 threads)")
    print("S1 final terms:", {k: round(v, 4) for k, v in terms.items()})
    assert float(loss) < 0.2 * first
