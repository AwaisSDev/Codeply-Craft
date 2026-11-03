"""Final-evaluation guard and the spec §10.5 outcome logic (synthetic per-episode rows; no frozen data read)."""
import json
import subprocess
import sys

import pytest

import paste.final_report as fr
from paste import final_eval as fe


def test_final_eval_refuses_without_committed_frozen_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(fe, "FROZEN_RUNS", str(tmp_path / "FROZEN-RUNS.json"))
    monkeypatch.setattr(sys, "argv", ["final_eval", "--run-name", "X", "--ckpt", "x.pt", "--data-dir", ".", "--files", "test-api.jsonl"])
    with pytest.raises(SystemExit) as e:
        fe.main()
    assert "committed" in str(e.value)


def _rows(n, tp, fp, fn, fw):
    z = dict.fromkeys(("WRITE", "UPDATE", "MERGE_INTO", "FORGET", "FORGET_PROFILE", "MERGE"), 0)
    return [{"id": f"p{i}", "tp": dict(z, WRITE=tp), "fp": dict(z, WRITE=fp), "fn": dict(z, WRITE=fn),
             "segments": 10, "false_writes": fw} for i in range(n)]


@pytest.mark.parametrize("paste,expect", [((9, 1, 1, 1), "Pass"), ((3, 3, 3, 3), "Fail"), ((5, 2, 2, 2), "Equivalent")])
def test_outcomes(tmp_path, monkeypatch, paste, expect):
    S = {"PASTE": [_rows(60, *paste)] * 3, "M1c": [_rows(60, 5, 2, 2, 2)] * 3, "M1c-m": [_rows(60, 5, 2, 2, 2)] * 3}
    monkeypatch.setattr(fr, "load", lambda files: S)
    out = tmp_path / "r.json"
    monkeypatch.setattr(sys, "argv", ["final_report", "--files", "t.jsonl", "--n-boot", "300", "--out", str(out)])
    fr.main()
    o = json.load(open(out))["outcome"]
    assert o.startswith(expect), o


def test_report_reads_bench_systems_latency(tmp_path, monkeypatch):
    S = {"PASTE": [_rows(60, 9, 1, 1, 1)] * 3, "M1c": [_rows(60, 5, 2, 2, 2)] * 3, "M1c-m": [_rows(60, 5, 2, 2, 2)] * 3}
    monkeypatch.setattr(fr, "load", lambda files: S)
    lat = {"results": [{"K": 32, "E": 8, "setting": "cold", "PASTE": {"p50_ms": 10.0}, "M1c": {"p50_ms": 50.0}},
                       {"K": 32, "E": 8, "setting": "steady", "PASTE": {"p50_ms": 80.0}, "M1c": {"p50_ms": 50.0},
                        "PASTE/M1c_p50": 1.6}]}
    (tmp_path / "lat.json").write_text(json.dumps(lat))
    out = tmp_path / "r.json"
    monkeypatch.setattr(sys, "argv", ["final_report", "--files", "t.jsonl", "--n-boot", "300", "--latency",
                                      str(tmp_path / "lat.json"), "--out", str(out)])
    fr.main()
    r = json.load(open(out))
    assert r["latency_p50_ms_K32"] == {"PASTE": 80.0, "M1c": 50.0}        # steady row, not cold
    assert not r["outcome"].startswith("Pass")                             # 80 > 1.5 x 50
