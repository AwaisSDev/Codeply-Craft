"""tools/t4_plan.py: AMP rule (all systems within 2 %, 10 log entries) and quota packing order."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import t4_plan as tp  # noqa: E402


def _smoke(amp_loss=1.0, n=10, fail=None):
    d = {}
    for s in ("PASTE", "M1c", "M1c-m", "M1cpW"):
        d[f"smoke-{s}"] = {"rc": 0, "loss": [1.0] * n, "seg_per_s": [10.0], "eval_seg_per_s": 30.0}
        d[f"smoke-{s}-amp"] = {"rc": 1 if fail == s else 0, "loss": [amp_loss] * n, "seg_per_s": [20.0]}
    return d


def test_amp_rule():
    assert tp.amp_rule(_smoke(1.015))[0] is True
    assert tp.amp_rule(_smoke(1.03))[0] is False
    assert tp.amp_rule(_smoke(1.0, n=2))[0] is False
    assert tp.amp_rule(_smoke(1.0, fail="M1c-m"))[0] is False


def test_order_puts_paste_and_m1c_seeds_first():
    assert tp.ORDER[:6] == [("PASTE", 1), ("M1c", 1), ("PASTE", 2), ("M1c", 2), ("PASTE", 3), ("M1c", 3)]
    h = tp.hours(10.0, 30.0, 4)
    assert 8.5 < h < 9.2                   # (4 x (53,890/10 + 10,663/30) + 17 x 10,663/30) s x 1.1 = 8.87 h
