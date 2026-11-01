"""T4 addressing, T5 temporary/persistent separation, T6 write gate, T7 contradiction path."""
import json

import pytest
import torch

from conftest import STORE, T0, seg
from paste.brain_sim import BrainSim
from paste.losses import gate_loss
from test_t02_t03 import _input, _with_temps

PERSISTENT_OPS = {"WRITE", "UPDATE", "MERGE_INTO"}


# ---------------------------------------------------------------- T4
def test_t04_addressing_distribution(adapter):
    m, hd = adapter.m, adapter.m.heads
    s_in, *_ = _input(adapter)
    enc = m.encode([s_in])[0]
    K, E = enc.att.shape[0], enc.prof.shape[0]
    with torch.no_grad():
        u = m.unit_outputs(enc, (3, 8), src=-1)
        lp = u["addr"]
        assert lp.shape[0] == K + E + 1
        tot = torch.logsumexp(lp, 0).item()
        print(f"T4 logsumexp over Omega = {tot:.2e} (K={K}, E={E})")
        assert abs(tot) < 1e-5
        # factorisation: P(j) = alpha_E(e_j) * alpha_A(j | e_j); P(NEW-ATTR(e)) = alpha_E(e) * alpha_A(NEW | e)
        q = u["qs"]
        s_ent = torch.cat([hd.ent_bil(q, enc.prof) + hd.ent_int(q, enc.prof), hd.ent_new(q)])
        log_ae = torch.log_softmax(s_ent, -1)
        key = hd.rec_key(torch.cat([enc.att, enc.val], -1))
        s_rec = hd.att_bil(q, key) + hd.att_int(q, key)
        worst = 0.0
        for e in range(E):
            idx = [j for j in range(K) if enc.rec_prof[j] == e]
            la = torch.log_softmax(torch.cat([s_rec[idx], hd.att_new(torch.cat([q, enc.prof[e]])).reshape(1)]), -1)
            for i, j in enumerate(idx):
                worst = max(worst, abs((log_ae[e] + la[i] - lp[j]).item()))
            worst = max(worst, abs((log_ae[e] + la[-1] - lp[K + e]).item()))
        worst = max(worst, abs((log_ae[-1] - lp[-1]).item()))
        print(f"T4 factorisation max|log-prob diff| = {worst:.2e}")
        assert worst < 1e-5
        # marginal over each profile's block equals the entity probability
        for e in range(E):
            block = [j for j in range(K) if enc.rec_prof[j] == e] + [K + e]
            assert abs(torch.logsumexp(lp[block], 0).item() - log_ae[e].item()) < 1e-5


@pytest.mark.parametrize("store", [[], STORE[:1], STORE[2:3]])
def test_t04_absent_records_and_new_entity(adapter, store):
    """Empty store, a store with only user records, and a profile with no user records: Omega stays valid,
    NEW-ENTITY is always available, and the user profile always has a NEW-ATTRIBUTE outcome."""
    m = adapter.m
    s_in, *_ = _input(adapter, store=store)
    enc = m.encode([s_in])[0]
    with torch.no_grad():
        lp = m.unit_outputs(enc, (3, 8), src=-1)["addr"]
    K, E = len(store), enc.prof.shape[0]
    assert lp.shape[0] == K + E + 1 and E >= 1
    assert torch.isfinite(lp[K:]).all(), "NEW-ATTR / NEW-ENT must always be finite"
    assert abs(torch.logsumexp(lp, 0).item()) < 1e-5
    print(f"T4 store size {K}: |Omega| = {lp.shape[0]}, P(NEW-ENT) = {lp[-1].exp().item():.3f}")


# ---------------------------------------------------------------- T5
SEGS = ["Remember that my sister Ayesha moved to Lahore.", "I prefer green tea now, not coffee.",
        "Forget my diet, please.", "lol imagine I lived on Mars", "Yes, remember that."]


def test_t05_no_persistent_ops_when_gate_closed(adapter):
    """With g == 0, no WRITE/UPDATE/MERGE_INTO/PROMOTE for any temporary state (invariant I1/I2)."""
    st0 = adapter.serialize(_with_temps(adapter))
    counts = {}
    for text in SEGS:
        out = adapter.step(seg(text), STORE, st0, gate_override=0.0)
        bad = [o for o in out["operations"] if o["op"] in PERSISTENT_OPS | {"MERGE"}] + [o for o in out["temp_ops"] if o["op"] == "PROMOTE"]
        assert not bad, bad
        for o in out["operations"]:
            counts[o["op"]] = counts.get(o["op"], 0) + 1
    print(f"T5 gate closed: no WRITE/UPDATE/MERGE_INTO/MERGE/PROMOTE (D1); remaining proposals: {counts}")


def test_t05_temp_to_persistent_only_by_promote(adapter):
    """When the gate is forced open, any WRITE whose value is a temporary item's text (not in the segment)
    must be accompanied by a PROMOTE of that item (I2)."""
    st0 = adapter.serialize(_with_temps(adapter))
    temp_texts = {it["text"] for it in _with_temps(adapter)["items"]}
    n_promote = 0
    for text in SEGS:
        out = adapter.step(seg(text), STORE, st0, gate_override=1.0)
        promoted = {o["item_id"] for o in out["temp_ops"] if o["op"] == "PROMOTE"}
        n_promote += len(promoted)
        for o in out["operations"]:
            v = o.get("payload", {}).get("value", "")
            if v in temp_texts and v not in text:
                assert promoted, f"temporary text reached a persistent proposal without PROMOTE: {o}"
    print(f"T5 gate open: {n_promote} PROMOTE operations, every temp-sourced write accompanied by PROMOTE")


def test_t05_session_boundary_resets(adapter):
    st = _with_temps(adapter)
    st["items"][1]["ttl"] = "OPEN"
    st["h"] = torch.randn(adapter.m.cfg.r_mem, adapter.m.cfg.d)
    st["session_id"] = "s1"
    st_json = adapter.serialize(st)
    prepared, events = adapter._prepare(adapter.deserialize(st_json), seg("Hi again", at=T0 + 3600, session="s2"))
    assert prepared["h"] is None, "h must be reset to h0 at a session boundary"
    assert [it["id"] for it in prepared["items"]] == ["t1"], "SESSION items must be dropped; OPEN items kept"
    same, _ = adapter._prepare(adapter.deserialize(st_json), seg("still here", at=T0 + 60, session="s1"))
    assert same["h"] is not None and len(same["items"]) == 3
    # h actually used for the first segment of the new session is h0
    s_in, *_ = adapter.build(seg("Hi again", session="s2"), STORE, prepared)
    assert s_in.h is None   # model.prefix substitutes h0
    print(f"T5 session boundary: h reset, dropped {[e['item_id'] for e in events]}")


def test_t05_until_and_cap_expiry(adapter):
    st = _with_temps(adapter)
    st["items"][0].update(ttl="UNTIL", until=T0 + 100)
    st["items"][2].update(ttl="OPEN", created_at=T0 - 15 * 86400)
    _, ev = adapter._prepare(st, seg("later", at=T0 + 200))
    assert {e["item_id"]: e["why"] for e in ev} == {"t0": "until passed", "t2": "14-day cap"}


def test_t05_merge_needs_licensing_gated_unit(adapter, monkeypatch):
    """D1: with the merge head saturated (p = 1), a MERGE appears only when a gated PERSIST unit in the segment
    is addressed to a record or profile of one of the pair; never otherwise."""
    hd = adapter.m.heads
    monkeypatch.setattr(hd, "merge_logits", lambda pairs, *a: torch.full((len(pairs),), 20.0))
    st0 = adapter.serialize(adapter.empty_state())
    closed = adapter.step(seg(SEGS[0]), STORE, st0, gate_override=0.0)
    assert not [o for o in closed["operations"] if o["op"] == "MERGE"]
    def addr_profile(target):        # address every unit to record `target`
        def f(q, prof, att, val, rec_prof):
            lp = torch.full((att.shape[0] + prof.shape[0] + 1,), -30.0); lp[target] = 0.0
            return lp
        return f
    monkeypatch.setattr(hd, "relation_logits", lambda q, a, v: torch.tensor([10.0, 0, 0, 0]))   # SAME -> MERGE_INTO
    monkeypatch.setattr(hd, "address", addr_profile(1))       # record m2 (profile Ayesha)
    opened = adapter.step(seg(SEGS[0]), STORE, st0, gate_override=1.0)
    merges = [o for o in opened["operations"] if o["op"] == "MERGE"]
    # licensed profiles: Ayesha only; every merge must involve an Ayesha record (m2) -- the only Ayesha record is
    # m2, which is already targeted by MERGE_INTO (one operation per record), so no pair can be licensed here.
    assert all("m2" in (o["target"], o["with"]) for o in merges)
    monkeypatch.setattr(hd, "address", addr_profile(0))       # record m1 (profile user, which also owns m4)
    opened = adapter.step(seg(SEGS[0]), STORE, st0, gate_override=1.0)
    merges = [o for o in opened["operations"] if o["op"] == "MERGE"]
    assert merges and all({o["target"], o["with"]} & {"m1", "m4"} for o in merges)
    print(f"T5/D1 merge head saturated: gate closed -> 0 merges; gated unit on the user's profile -> {len(merges)} merge(s), all on user records")


# ---------------------------------------------------------------- T6
def test_t06_thresholds_respected(adapter):
    st0 = adapter.serialize(adapter.empty_state())
    m = adapter.m
    for g, expect_writes in ((0.49, False), (0.5, True)):
        n = 0
        for text in SEGS:
            out = adapter.step(seg(text), STORE, st0, gate_override=g)
            n += sum(o["op"] in PERSISTENT_OPS for o in out["operations"])
            units = len(out["units"])
        print(f"T6 gate={g} (theta_W={adapter.th['write']}): persistent proposals {n}")
        assert (n > 0) == expect_writes or units == 0


def test_t06_cost_weighted_gradient():
    """d/dlogit of the gate loss: y=0 side is 3x plain BCE, y=1 side equals plain BCE."""
    x = torch.linspace(-4, 4, 17, requires_grad=True)
    g0 = torch.autograd.grad(gate_loss(x, torch.zeros_like(x)).sum(), x)[0]
    g1 = torch.autograd.grad(gate_loss(x, torch.ones_like(x)).sum(), x)[0]
    p = torch.sigmoid(x).detach()
    assert torch.allclose(g0, 3 * p, atol=1e-6) and torch.allclose(g1, p - 1, atol=1e-6)
    print(f"T6 gradient FP side / plain BCE = {(g0 / p).mean().item():.4f}")


# ---------------------------------------------------------------- T7
def test_t07_contradiction_maps_to_challenge(adapter, monkeypatch):
    """Decode: a unit addressed to a record with relation CONTRADICTION yields UPDATE(challenge)."""
    hd = adapter.m.heads
    K = len(STORE)
    def addr_record0(q, prof, att, val, rec_prof):
        lp = torch.full((att.shape[0] + prof.shape[0] + 1,), -30.0); lp[0] = 0.0
        return lp
    monkeypatch.setattr(hd, "address", addr_record0)
    for rel_i, rel in enumerate(["SAME", "UPDATE", "CORRECTION", "CONTRADICTION"]):
        monkeypatch.setattr(hd, "relation_logits", lambda q, a, v, r=rel_i: torch.nn.functional.one_hot(torch.tensor(r), 4).float() * 10)
        out = adapter.step(seg("I live in Islamabad now."), STORE, None, gate_override=1.0)
        ops = [o for o in out["operations"] if o.get("target") == "m1"]
        assert ops, out["operations"]
        o = ops[0]
        expected = ("MERGE_INTO", None) if rel == "SAME" else ("UPDATE", rel == "CONTRADICTION")
        assert (o["op"], o.get("challenge")) == expected, (rel, o)
        print(f"T7 relation {rel} -> {o['op']} challenge={o.get('challenge')}")


def test_t07_simulator_challenge_then_replace():
    b = BrainSim()
    r = b.add("user", "the user", {"attribute": "home city", "value": "Karachi", "certainty": "stated", "kind": "fact"}, "f1")
    rid = r["id"]
    up = {"op": "UPDATE", "target": rid, "challenge": True, "payload": {"attribute": "home city", "value": "Islamabad", "certainty": "stated"}}
    assert b.apply(up)["action"] == "challenged" and b.records[rid]["value"] == "Karachi"
    assert b.apply(up)["action"] == "replaced" and b.records[rid]["value"] == "Islamabad"
    assert b.records[rid]["status"] == "tentative" and b.records[rid]["history"][-1]["value"] == "Karachi"
    print("T7 simulator: challenged once, replaced on the second challenge (brain.js CHALLENGE_TO_SWITCH = 2)")
