"""tools/make_groups.py: identical recipe for all four systems, LR by family, seed-1-first order, pending refused."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "tools"))
import make_groups as mg  # noqa: E402


def test_runs_identical_except_lr_and_profile_rows():
    rs = mg.runs("V3", {"PASTE": 5e-5, "M1c": 1e-4}, 3000, amp=True)
    assert [r["name"] for r in rs[:7]] == ["PASTE-s1", "M1c-s1", "PASTE-s2", "M1c-s2", "PASTE-s3", "M1c-s3", "M1c-m-s1"]
    assert len(rs) == 12
    strip = lambda a: a.replace(" --profile-rows", "").replace("--lr-enc 5e-05", "LR").replace("--lr-enc 0.0001", "LR")
    assert len({strip(r["args"]) for r in rs}) == 1
    assert all("--corrupt-del 0.06" in r["args"] and "--amp" in r["args"] for r in rs)
    assert rs[0]["slices"] == ["0-1500", "3000-4500"] and "--lr-enc 5e-05" in rs[0]["args"] and "--lr-enc 0.0001" in rs[1]["args"]


def test_pending_recipe_refused(tmp_path):
    p = tmp_path / "r.json"
    p.write_text(json.dumps({"variant": {"decision": "pending"}, "lr": {"PASTE": {"decision": 5e-5}, "M1c": {"decision": 5e-5}},
                             "data": {"decision": 6000}}))
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "make_groups.py"), "--recipe", str(p), "--out",
                        str(tmp_path / "g.json")], capture_output=True, text=True)
    assert r.returncode != 0 and "pending" in r.stderr
