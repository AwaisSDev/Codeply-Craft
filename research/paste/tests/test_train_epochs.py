"""Trainer: --val-every-epoch writes per-epoch val, epoch checkpoints, epochs.json, and final.pt = best epoch.
Default (no flag) output names are unchanged. Uses 2 real train episodes and 1 val episode (PASTE_DATA)."""
import json
import os
import subprocess
import sys

import pytest
import torch

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("PASTE_DATA", os.path.expanduser("~/paste-data"))
TRAIN = os.path.join(DATA, "train", "train-mix-full.jsonl")
VAL = os.path.join(DATA, "train", "val-programmatic.jsonl")


@pytest.mark.skipif(not os.path.exists(TRAIN), reason="needs PASTE_DATA")
def test_val_every_epoch(tmp_path):
    out = tmp_path / "run"
    cmd = [sys.executable, "-m", "paste.train", "--system", "PASTE", "--head-norm", "--train", f"{TRAIN}:0-2",
           "--val", VAL, "--val-limit", "1", "--epochs", "2", "--accum", "1", "--curriculum", "0", "--threads", "1",
           "--ckpt-every", "100", "--val-every-epoch", "--patience", "5", "--out", str(out)]
    subprocess.run(cmd, check=True, cwd=HERE, capture_output=True)
    ep = json.load(open(out / "epochs.json"))
    assert [h["epoch"] for h in ep["epochs"]] == [1, 2] and not ep["early_stopped"]
    best = ep["best_epoch"]
    f = torch.load(out / "final.pt", weights_only=False)
    e = torch.load(out / f"epoch{best}.pt", weights_only=False)
    assert f["epoch"] == best
    assert all(torch.equal(f["model"][k], e["model"][k]) for k in f["model"])
    assert (out / "val.json").exists() and (out / "val-per-episode-val-programmatic.jsonl").exists()
