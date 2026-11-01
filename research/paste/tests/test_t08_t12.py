"""T8 serialisation, T9 determinism, T10 checkpoint/restore, T11 parameter counts, T12 Brain simulator rules."""
import importlib.util
import json
import os

import pytest
import torch

from conftest import STORE, T0, build_model, seg
from paste.adapter import PasteAdapter
from paste.brain_sim import BrainSim
from test_t02_t03 import _with_temps

EPISODE = [("My sister Ayesha moved to Lahore last week.", T0, "s1"),
           ("I'm calling the bank at 3pm today about my card.", T0 + 120, "s1"),
           ("Actually make that 5pm.", T0 + 300, "s1"),
           ("lol imagine I lived on Mars", T0 + 400, "s1"),
           ("I switched from coffee to green tea.", T0 + 90000, "s2"),
           ("Please forget my diet, I'm not vegetarian anymore.", T0 + 90100, "s2")]


def _strip(out):
    return json.loads(json.dumps({k: v for k, v in out.items()}, default=float))


def run(adapter, episode, state=None):
    outs = []
    for text, at, sess in episode:
        o = adapter.step(seg(text, at=at, session=sess), STORE, state)
        state = o["temp_state"]
        outs.append(_strip(o))
    return outs, state


# ---------------------------------------------------------------- T8
def test_t08_serialisation_round_trip(adapter):
    # An untrained model may create no temporary items (first run of this test failed on that precondition),
    # so the episode starts from a state seeded with three items and a non-zero h.
    seeded = _with_temps(adapter)
    seeded.update(h=torch.randn(adapter.m.cfg.r_mem, adapter.m.cfg.d, generator=torch.Generator().manual_seed(11)),  # seeded: the global
                  session_id="s1", last_at=T0 - 60)                                                               # RNG depends on test order
    _, st = run(adapter, EPISODE[:4], adapter.serialize(seeded))
    assert st["items"], "the test needs a non-empty temporary state"
    blob = json.dumps(st)
    again = adapter.serialize(adapter.deserialize(json.loads(blob)))
    assert again == st, "serialize(deserialize(x)) != x"
    a = adapter.deserialize(st)
    assert torch.equal(a["h"], adapter.deserialize(json.loads(blob))["h"])
    o1 = _strip(adapter.step(seg(*EPISODE[4][:1], at=EPISODE[4][1], session=EPISODE[4][2]), STORE, st))
    o2 = _strip(adapter.step(seg(*EPISODE[4][:1], at=EPISODE[4][1], session=EPISODE[4][2]), STORE, json.loads(blob)))
    assert o1 == o2
    print(f"T8 state with {len(st['items'])} items, {len(blob)} bytes JSON; exact round trip; identical next step")


# ---------------------------------------------------------------- T9
def test_t09_determinism(text):
    torch.use_deterministic_algorithms(True)
    try:
        outs = []
        for _ in range(2):
            m = build_model(perturb=True)
            outs.append(run(PasteAdapter(m, text), EPISODE)[0])
        assert outs[0] == outs[1]
        # and repeated calls on the same instance (warm record cache) give the same result
        ad = PasteAdapter(build_model(perturb=True), text)
        assert run(ad, EPISODE)[0] == run(ad, EPISODE)[0]
    finally:
        torch.use_deterministic_algorithms(False)
    print(f"T9 two fresh models and a warm-cache rerun: identical outputs over {len(EPISODE)} segments")


def test_t09_independent_of_cache_history(text):
    """Outputs must not depend on what was encoded before (first full-suite run exposed this: cached record
    states depended on batch composition by 4.6e-5 and T8's untrained decisions changed)."""
    m = build_model(perturb=True)
    ad = PasteAdapter(m, text)
    cold, _ = run(ad, EPISODE)
    a, _ = text.encode("Ayesha (sister) · home city: Lahore")
    b, _ = text.encode("Ali (coworker) · favourite drink: green tea with a lot of milk and sugar")
    m.clear_cache(); alone = m._ctx([a])[0].clone()
    m.clear_cache(); together = m._ctx([b, a])[1]
    assert torch.equal(alone, together), "record encoding depends on what it is encoded with"
    m.clear_cache()
    run(PasteAdapter(m, text), list(reversed(EPISODE)))          # warm the cache in a different order
    warm, _ = run(ad, EPISODE)
    assert cold == warm
    print("T9 record encoding independent of batch composition; cold-cache and differently-warmed outputs identical")


# ---------------------------------------------------------------- T10
def test_t10_checkpoint_restore_mid_episode(text):
    full, _ = run(PasteAdapter(build_model(perturb=True), text), EPISODE)
    first, st = run(PasteAdapter(build_model(perturb=True), text), EPISODE[:3])
    blob = json.dumps(st)                                        # checkpoint to text, new process-equivalent model
    rest, _ = run(PasteAdapter(build_model(perturb=True), text), EPISODE[3:], json.loads(blob))
    assert first + rest == full
    print("T10 6 segments uninterrupted == 3 segments + checkpoint + 3 segments in a fresh model (identical)")


# ---------------------------------------------------------------- T11
def _spec_counts():
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "param_count.py")
    spec = importlib.util.spec_from_file_location("param_count", p)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("backbone,expected", [("ettin-encoder-32m", 39_256_598), ("ettin-encoder-17m", 20_699_030)])
def test_t11_parameter_counts(backbone, expected):
    pc = _spec_counts()
    m = build_model(backbone)
    total = sum(p.numel() for p in m.parameters())
    enc = sum(p.numel() for p in m.enc.parameters())
    heads = sum(p.numel() for p in m.heads.parameters())
    pathway = sum(p.numel() for p in m.memory_pathway_parameters())
    b = pc.BACKBONES[backbone]
    print(f"T11 {backbone}: total {total:,} (spec {expected:,}); encoder {enc:,}; shared heads {heads:,} (spec "
          f"{pc.count(pc.shared_heads(b['d'])):,}); memory pathway {pathway:,} (spec {pc.count(pc.paste_specific(b['d'])):,})")
    assert enc == b["encoder"]
    assert heads == pc.count(pc.shared_heads(b["d"]))
    assert pathway == pc.count(pc.paste_specific(b["d"]))
    assert total == expected == enc + heads + pathway


def test_t11_head_norm_adds_no_parameters(text):
    """D2: the head_norm pilot variant is parameter-free, and normalises exactly the head inputs."""
    m = build_model()
    n0 = sum(p.numel() for p in m.parameters())
    m.cfg.head_norm = True
    try:
        ad = PasteAdapter(m, text)
        s_in, *_ = ad.build(seg("My sister Ayesha moved to Lahore."), STORE, ad.empty_state())
        e = m.encode([s_in])[0]
        assert sum(p.numel() for p in m.parameters()) == n0
        for t in (e.seg, e.prof, e.att, e.val):
            assert torch.allclose(t.mean(-1), torch.zeros(t.shape[0]), atol=1e-5)
            assert torch.allclose(t.var(-1, unbiased=False), torch.ones(t.shape[0]), atol=1e-3)
        assert e.mem.abs().max() > 5, "memory-token outputs feed GRU_H and must stay raw"
    finally:
        m.cfg.head_norm = False
    print(f"T11/D2 head_norm: parameters unchanged ({n0:,}); head inputs normalised; memory tokens raw")


# ---------------------------------------------------------------- T12
P = lambda v, c="stated", a="home city": {"attribute": a, "value": v, "certainty": c, "kind": "fact"}


def test_t12_brain_rules():
    b = BrainSim()
    # added: stated -> confirmed, implied -> tentative
    r1 = b.add("user", "the user", P("Karachi"), "f1")["id"]
    r2 = b.add("user", "the user", P("jazz", "implied", "music"), "f2")["id"]
    assert b.records[r1]["status"] == "confirmed" and b.records[r2]["status"] == "tentative"
    # ignored: joking / hypothetical / quoting, and secrets
    for c in ("joking", "hypothetical", "quoting"):
        assert b.add("user", "the user", P("Mars", c), "x")["action"] == "ignored"
    assert b.add("user", "the user", P("my password is hunter2", a="note"), "x")["action"] == "ignored"
    # reinforced: same value; tentative -> confirmed on evidence >= 2
    assert b.apply({"op": "MERGE_INTO", "target": r2, "payload": P("jazz", "implied", "music")})["confirmed"] is True
    # replaced: stated new value on a confirmed record
    assert b.apply({"op": "UPDATE", "target": r1, "payload": P("Lahore")})["action"] == "replaced"
    # challenged: implied different value on a confirmed record; replaced on the second matching challenge
    assert b.apply({"op": "UPDATE", "target": r1, "payload": P("Multan", "implied")})["action"] == "challenged"
    assert b.apply({"op": "UPDATE", "target": r1, "payload": P("Quetta", "implied")})["action"] == "challenged"  # different challenger resets
    assert b.apply({"op": "UPDATE", "target": r1, "payload": P("Quetta", "implied")})["action"] == "replaced"
    # locked records are kept
    r3 = b.add("user", "the user", P("dark mode", a="theme"), "f3", locked=True)["id"]
    assert b.apply({"op": "UPDATE", "target": r3, "payload": P("light mode", a="theme")})["action"] == "kept"
    assert b.records[r3]["value"] == "dark mode"
    # merge keeps the record with more evidence and folds evidence
    r4 = b.add("sister:Ayesha", "Ayesha (sister)", P("Lahore"), "f4")["id"]
    r5 = b.add("sister:Ayesha", "Ayesha (sister)", P("Lahore"), "f4dup")["id"]
    b.apply({"op": "MERGE_INTO", "target": r4, "payload": P("Lahore")})
    assert b.apply({"op": "MERGE", "target": r5, "with": r4})["kept"] == r4 and r5 not in b.records
    assert b.records[r4]["evidence"] == 3
    # forget: one record, then a whole profile
    assert b.apply({"op": "FORGET", "target": r2})["action"] == "forgotten" and r2 not in b.records
    assert b.apply({"op": "FORGET_PROFILE", "entity": "sister:Ayesha"})["count"] == 1
    # provenance is kept for evaluation
    assert b.records[r1]["provenance"] == "f1"
    # capacity eviction: lowest evidence, then oldest
    small = BrainSim(capacity=2)
    a = small.add("user", "u", P("1", a="a"), "p1")["id"]; small.apply({"op": "MERGE_INTO", "target": a, "payload": P("1", a="a")})
    bb = small.add("user", "u", P("2", a="b"), "p2")["id"]
    small.add("user", "u", P("3", a="c"), "p3")
    assert a in small.records and bb not in small.records
    print("T12 Brain simulator: added/ignored/reinforced/confirmed/replaced/challenged/kept/merged/forgotten/evicted all as specified")
