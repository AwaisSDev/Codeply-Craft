"""Central-test training groups (CENTRAL-TEST-PLAN §1-§3) from the recipe chosen on validation (tools/choose_recipe.py).

Every system gets the identical recipe; only the encoder LR differs by family (PASTE; M1c family), as pre-registered.
Order: seed 1 of all four systems first, then seeds 2 and 3 (plan §3). Runs are packed into groups of --per-group runs
(one Kaggle session each). Output is the --runs JSON of scripts/kaggle/make_notebooks.py.

    python tools/make_groups.py --recipe recipe.json --per-group 2 [--amp] [--episodes 6000] --out groups.json
"""
import argparse
import json

SYSTEMS = ("PASTE", "M1c", "M1c-m", "M1c+W")
VARIANT_ARGS = {"V0": "", "V1": "--closed-loop 0.5", "V2": "--closed-loop 0.5 --mix segment",
                "V3": "--corrupt-del 0.06 --corrupt-ins 0.06", "V4": "--corrupt-prof 0.1"}
BASE = "--epochs 4 --val-every-epoch --patience 1 --accum 2 --bio-weight 5 --val-tf 10 --ckpt-every 250 --head-norm"
# train-mix-full: plans 0-2,999 mostly API wording, 3,000-5,999 programmatic; equal halves keep the E27 proportions
SLICES = {6000: ["0-6000"], 3000: ["0-1500", "3000-4500"]}


def runs(variant, lr, episodes, amp, seeds=(1, 2, 3)):
    out = []
    for seed in seeds:
        for s in SYSTEMS:
            fam = "PASTE" if s == "PASTE" else "M1c"
            args = " ".join(x for x in (BASE, "--profile-rows" if s == "PASTE" else "", VARIANT_ARGS[variant],
                                        f"--lr-enc {lr[fam]:g}", "--amp" if amp else "") if x)
            out.append({"name": f"{s.replace('+', 'p')}-s{seed}", "system": s, "seed": seed, "slices": SLICES[episodes],
                        "args": args})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recipe", required=True)
    ap.add_argument("--episodes", type=int, choices=(3000, 6000), help="default: the recipe's data decision")
    ap.add_argument("--amp", action="store_true")
    ap.add_argument("--per-group", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    r = json.load(open(a.recipe))
    pend = [k for k, v in (("variant", r["variant"]), ("data", r["data"])) if v["decision"] == "pending"]
    pend += [f"lr/{s}" for s, v in r["lr"].items() if v["decision"] == "pending"]
    if pend and not a.episodes:
        raise SystemExit(f"recipe decisions still pending: {pend}")
    if any(p != "data" for p in pend):
        raise SystemExit(f"recipe decisions still pending: {pend}")
    rs = runs(r["variant"]["decision"], {s: r["lr"][s]["decision"] for s in ("PASTE", "M1c")},
              a.episodes or r["data"]["decision"], a.amp)
    groups = [rs[i:i + a.per_group] for i in range(0, len(rs), a.per_group)]
    json.dump(groups, open(a.out, "w"), indent=1)
    print(f"{len(rs)} runs in {len(groups)} groups -> {a.out}")
    for g in groups:
        print([x["name"] for x in g])


if __name__ == "__main__":
    main()
