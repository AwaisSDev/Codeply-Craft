"""tools/choose_recipe.py applies the pre-registered rules: preference within noise, FPM guard, LR default, pending."""
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "tools"))
import choose_recipe as cr  # noqa: E402


def _sc(pe, fpm=None):
    return {k: {"PE": v, "FPM": (fpm or {}).get(k, 30.0)} for k, v in pe.items()}


BASE = {"V0/PASTE": 0.60, "V0/M1c": 0.68, "V1/PASTE": 0.60, "V1/M1c": 0.68, "V2/PASTE": 0.60, "V2/M1c": 0.68,
        "V3/PASTE": 0.60, "V3/M1c": 0.68, "V4/PASTE": 0.60, "V4/M1c": 0.68}


def test_variant_prefers_spec_default_within_noise():
    sc = _sc(dict(BASE, **{"V3/PASTE": 0.61, "V3/M1c": 0.685}))      # V3 better by 0.0075 < 0.010
    assert cr.choose_variant(sc, 0.010)["decision"] == "V1"


def test_variant_clear_winner_and_fpm_guard():
    sc = _sc(dict(BASE, **{"V3/PASTE": 0.64, "V3/M1c": 0.70}))
    assert cr.choose_variant(sc, 0.010)["decision"] == "V3"
    sc = _sc(dict(BASE, **{"V3/PASTE": 0.64, "V3/M1c": 0.70}), {"V3/M1c": 34.0})  # FPM +13 % for M1c
    assert cr.choose_variant(sc, 0.010)["decision"] == "V1"


def test_variant_v1_worse_falls_to_v0():
    sc = _sc(dict(BASE, **{"V1/PASTE": 0.55, "V1/M1c": 0.66}))
    assert cr.choose_variant(sc, 0.010)["decision"] == "V0"


def test_pending_and_noise():
    sc = _sc({"V0/PASTE": 0.60, "V0/M1c": 0.68})
    assert cr.choose_variant(sc, 0.01)["decision"] == "pending"
    assert cr.choose_data(sc, 0.01)["decision"] == "pending"
    assert cr.noise(sc) == (0.010, "floor (S2 pending)")
    assert cr.noise(_sc({"V0/PASTE": 0.60, "S2/PASTE": 0.625}))[0] == 0.025


def test_lr_keeps_default_unless_clearly_better():
    sc = _sc({"V0/PASTE": 0.60, "LR3e-5/PASTE": 0.605, "LR1e-4/PASTE": 0.63,
              "V0/M1c": 0.68, "LR3e-5/M1c": 0.685, "LR1e-4/M1c": 0.66})
    out = cr.choose_lr(sc, 0.010)
    assert out["PASTE"]["decision"] == 1e-4 and out["M1c"]["decision"] == 5e-5


def test_data_curve():
    sc = _sc({"LC3000/PASTE": 0.62, "LC6000/PASTE": 0.66, "LC3000/M1c": 0.70, "LC6000/M1c": 0.705})
    d = cr.choose_data(sc, 0.010)
    assert d["decision"] == 6000 and d["still_improving"] == {"PASTE": True, "M1c": False}
    assert d["fallback_3000_permitted"] is False
