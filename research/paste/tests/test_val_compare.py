"""tools/val_compare.py: cross-fitting never scores an episode at a threshold chosen on it; pairs run."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "tools"))


def _rec(i, tp, fp, fn):
    z = {k: 0 for k in ("WRITE", "UPDATE", "MERGE_INTO", "FORGET", "FORGET_PROFILE", "MERGE")}
    return {"id": f"p{i:03d}", "tp": dict(z, WRITE=tp), "fp": dict(z, WRITE=fp), "fn": dict(z, WRITE=fn),
            "segments": 10, "false_writes": fp}


def _sweep(run, good):
    os.makedirs(os.path.join(run, "sweep"))
    for th in (0.5, 0.9):
        per = [_rec(i, 5 if good else 3, 1 if th == 0.9 else 4, 1) for i in range(40)]
        json.dump({"theta_W": th, "files": {"a.jsonl": per, "b.jsonl": per}}, open(os.path.join(run, "sweep", f"th{th:.2f}.json"), "w"))


def test_crossfit_and_pairs(tmp_path):
    import val_compare as vc
    _sweep(tmp_path / "A", True); _sweep(tmp_path / "B", False)
    sw = vc.load_sweep(str(tmp_path / "A"))
    chosen, rows = vc.cross_fit(sw)
    assert chosen == {0: 0.9, 1: 0.9} and len(rows) == 80
    assert {vc.fold(r["id"]) for r in rows} == {0, 1}
    out = tmp_path / "cmp.json"
    subprocess.run([sys.executable, os.path.join(HERE, "tools", "val_compare.py"), "--runs", f"A={tmp_path/'A'}",
                    f"B={tmp_path/'B'}", "--pairs", "A:B", "--n-boot", "200", "--out", str(out)], check=True)
    r = json.load(open(out))
    assert r["pairs"]["A - B"]["PE"]["delta"] > 0
    assert r["runs"]["A"]["crossfit"]["PE"] == r["runs"]["A"]["insample"]["PE"]
