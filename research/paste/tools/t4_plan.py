"""2026-11-07 decisions from the T4 smoke (`smoke.json` of the paste-smoke notebook), by rules fixed in advance:

* **AMP rule** (DECISIONS 2026-11-03): AMP for all systems iff, for every system, both runs succeeded and the mean
  loss of the last 10 log entries under AMP is within 2 % (relative) of fp32; otherwise fp32 for all.
* **GPU-hour budget** (CENTRAL-TEST-PLAN §3-§4): per run, up to 4 epochs x (training segments / train segments-per-s
  + full-val segments / eval segments-per-s) + calibration (≈ 16 closed-loop full-val passes + teacher-forced part,
  counted as 17 passes), + 10 % overhead (model load, checkpoints, notebook setup). Worst case (4 epochs) and a
  2-epoch case are reported. Run order: PASTE and M1c seeds 1-3 first (owner, 2026-11-04), then M1c-m and M1c+W.
  The runs that fit the remaining quota are listed; the others wait for the next weekly refresh (reported, never
  shortened: the 3,000-episode fallback is not permitted, DECISIONS 2026-11-04).

    python tools/t4_plan.py --smoke smoke.json --quota-h 29.5 [--out plan.json]
"""
import argparse
import json

TRAIN_SEGS = 53_890          # train-mix-full, all 6,000 episodes
VAL_SEGS = 5_473 + 5_190     # val-programmatic + val-api (full val, per-epoch val and calibration)
CAL_PASSES = 17
OVERHEAD = 1.10
ORDER = [(s, k) for k in (1, 2, 3) for s in ("PASTE", "M1c")] + [(s, k) for k in (1, 2, 3) for s in ("M1c-m", "M1c+W")]


def amp_rule(smoke):
    out, ok_all = {}, True
    for s in ("PASTE", "M1c", "M1c-m", "M1c+W"):
        f, a = smoke.get(f"smoke-{s.replace('+', 'p')}"), smoke.get(f"smoke-{s.replace('+', 'p')}-amp")
        if not f or not a or f["rc"] or a["rc"] or len(f["loss"]) < 10 or len(a["loss"]) < 10:
            out[s] = {"ok": False, "reason": "missing, failed, or fewer than 10 log entries"}
            ok_all = False
            continue
        lf, la = sum(f["loss"][-10:]) / 10, sum(a["loss"][-10:]) / 10
        rel = abs(la - lf) / lf
        out[s] = {"ok": rel <= 0.02, "loss_fp32": round(lf, 4), "loss_amp": round(la, 4), "rel_diff": round(rel, 4),
                  "speedup": round(a["seg_per_s"][-1] / f["seg_per_s"][-1], 3)}
        ok_all &= rel <= 0.02
    return ok_all, out


def hours(train_sps, eval_sps, epochs):
    return OVERHEAD * (epochs * (TRAIN_SEGS / train_sps + VAL_SEGS / eval_sps) + CAL_PASSES * VAL_SEGS / eval_sps) / 3600


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", required=True)
    ap.add_argument("--quota-h", type=float, required=True, help="GPU hours remaining (kaggle quota)")
    ap.add_argument("--out")
    a = ap.parse_args()
    smoke = json.load(open(a.smoke))
    use_amp, amp = amp_rule(smoke)
    per_sys = {}
    for s in ("PASTE", "M1c", "M1c-m", "M1c+W"):
        key = f"smoke-{s.replace('+', 'p')}"
        tr = smoke[key + ("-amp" if use_amp else "")]["seg_per_s"][-1]
        ev = smoke[key]["eval_seg_per_s"]
        per_sys[s] = {"train_seg_per_s": tr, "eval_seg_per_s": ev, "h_4_epochs": round(hours(tr, ev, 4), 2),
                      "h_2_epochs": round(hours(tr, ev, 2), 2)}
    left, fits, waits = a.quota_h, [], []
    for s, k in ORDER:
        h = per_sys[s]["h_4_epochs"]
        if h <= left:
            fits.append(f"{s}-s{k}"); left -= h
        else:
            waits.append(f"{s}-s{k}")
    res = {"use_amp": use_amp, "amp_rule": amp, "per_system": per_sys, "quota_h": a.quota_h,
           "fits_worst_case": fits, "waits_for_refresh": waits, "left_h": round(left, 2),
           "total_worst_case_h": round(sum(per_sys[s]["h_4_epochs"] for s, _ in ORDER), 1),
           "total_2_epochs_h": round(sum(per_sys[s]["h_2_epochs"] for s, _ in ORDER), 1)}
    print(json.dumps(res, indent=1))
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
