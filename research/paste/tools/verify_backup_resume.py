"""End-to-end check of backup → restore → resume (validation data only; small CPU runs).

  A: uninterrupted run (train with per-epoch val, then paste.calibrate_full).
  B: the same run killed mid-training after a checkpoint, snapshotted to the private HF repo, its local directory
     deleted, restored into a fresh directory (as a new machine or Kaggle account would), resumed to the end; then
     calibration killed after some configurations, snapshotted, deleted, restored and resumed.
  Pass: B's final.pt equals A's tensor for tensor (exact resume), B's calibration equals A's, every restore verified
  every sha256, and a second restore into a non-empty directory is refused.

    python tools/verify_backup_resume.py --work DIR [--prefix selftest-<stamp>]
"""
import argparse
import datetime
import json
import os
import shutil
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from paste import backup  # noqa: E402

DATA = os.environ.get("DATA", os.path.expanduser("~/paste-data/train"))
VAL = [f"{DATA}/val-programmatic.jsonl", f"{DATA}/api-val/val-api.jsonl"]
TRAIN_ARGS = ["--system", "PASTE", "--seed", "1", "--train", f"{DATA}/train-mix-full.jsonl:0-8", "--val", *VAL,
              "--epochs", "2", "--val-every-epoch", "--patience", "1", "--accum", "2", "--bio-weight", "5",
              "--ckpt-every", "2", "--head-norm", "--profile-rows", "--closed-loop", "0.5", "--lr-enc", "1e-4",
              "--val-limit", "2", "--curriculum", "0", "--threads", "2"]
CAL_ARGS = ["--val", *VAL, "--limit", "3", "--tf-limit", "2", "--threads", "2"]


def popen(args):
    return subprocess.Popen([sys.executable, *args], start_new_session=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def kill_when(p, cond, timeout=900):
    t = time.time()
    while time.time() - t < timeout:
        if p.poll() is not None:
            raise SystemExit("process ended before the kill point; make the run longer")
        if cond():
            os.killpg(p.pid, signal.SIGKILL); p.wait()
            return
        time.sleep(0.5)
    raise SystemExit("kill point not reached")


def run(args):
    r = subprocess.run([sys.executable, *args], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stdout[-2000:] + r.stderr[-2000:])
    return r.stdout


def same_weights(p, q):
    import torch
    a = torch.load(p, weights_only=False, map_location="cpu")["model"]
    b = torch.load(q, weights_only=False, map_location="cpu")["model"]
    return a.keys() == b.keys() and all(torch.equal(a[k], b[k]) for k in a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--prefix", default="selftest-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    a = ap.parse_args()
    shutil.rmtree(a.work, ignore_errors=True); os.makedirs(a.work)
    A, B, B2, B3 = (os.path.join(a.work, x) for x in ("A", "B", "B-restored", "B-restored-cal"))
    res = {"prefix": a.prefix}

    run(["-m", "paste.train", *TRAIN_ARGS, "--out", A])
    run(["-m", "paste.calibrate_full", "--run", A, *CAL_ARGS])

    # B: kill after the first mid-epoch checkpoint of epoch 2 (pos > 8), back up, delete, restore, resume
    p = popen(["-m", "paste.train", *TRAIN_ARGS, "--out", B])
    def past_epoch1():
        lp = os.path.join(B, "log.jsonl")
        return os.path.exists(lp) and any(json.loads(l).get("pos", 0) >= 10 for l in open(lp) if l.strip())
    kill_when(p, past_epoch1)
    man = backup.snapshot(B, "verify-run", prefix=a.prefix, label="killed-mid-training")
    res["resume_point"] = man["resume_point"]
    shutil.rmtree(B)
    backup.restore("verify-run", B2, prefix=a.prefix)
    out = run(["-m", "paste.train", *TRAIN_ARGS, "--out", B2])
    res["resumed_message"] = next((l for l in out.splitlines() if l.startswith("resumed at")), None)
    res["exact_resume_final_pt_equal"] = same_weights(os.path.join(A, "final.pt"), os.path.join(B2, "final.pt"))

    # calibration: kill after 3 configurations, back up, delete, restore, resume
    p = popen(["-m", "paste.calibrate_full", "--run", B2, *CAL_ARGS])
    part = os.path.join(B2, "calibration-full.json.partial.json")
    kill_when(p, lambda: os.path.exists(part) and len(json.load(open(part))["rows"]) >= 3)
    backup.snapshot(B2, "verify-run", prefix=a.prefix, label="killed-mid-calibration")
    shutil.rmtree(B2)
    backup.restore("verify-run", B3, prefix=a.prefix)
    out = run(["-m", "paste.calibrate_full", "--run", B3, *CAL_ARGS])
    res["calibration_resumed"] = next((json.loads(l) for l in out.splitlines() if "resumed_configs" in l), None)
    ca = json.load(open(os.path.join(A, "calibration-full.json")))["chosen"]
    cb = json.load(open(os.path.join(B3, "calibration-full.json")))["chosen"]
    res["calibration_equal"] = ca == cb

    # final snapshot of the finished run, and the overwrite guard
    backup.snapshot(B3, "verify-run", prefix=a.prefix, label="finished")
    try:
        backup.restore("verify-run", B3, prefix=a.prefix)
        res["restore_refuses_overwrite"] = False
    except SystemExit:
        res["restore_refuses_overwrite"] = True
    res["snapshots"] = backup.snapshots("verify-run", a.prefix)
    res["PASS"] = bool(res["exact_resume_final_pt_equal"] and res["calibration_equal"] and res["restore_refuses_overwrite"]
                       and res["resumed_message"] and res["calibration_resumed"])
    print(json.dumps(res, indent=1))
    json.dump(res, open(os.path.join(a.work, "verify.json"), "w"), indent=1)
    sys.exit(0 if res["PASS"] else 1)


if __name__ == "__main__":
    main()
