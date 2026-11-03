"""Option-B training mix (DECISIONS.md 2026-11-02/03): plans 0-2,999 in API wording where a valid realisation
exists, else their programmatic wording (same labels); plans 3,000-5,999 in programmatic wording. Deterministic;
rebuild whenever more API chunks arrive.

    python -m data.mix --train-dir ~/paste-data/train --out ~/paste-data/train/train-mix.jsonl
"""
import argparse
import glob
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--api-plans", type=int, default=3000)
    a = ap.parse_args()
    api = {}
    for f in sorted(glob.glob(os.path.join(a.train_dir, "api-train", "chunk-*", "train-api.jsonl"))):
        for l in open(f):
            ep = json.loads(l); api[ep["id"]] = ep
    n_api = n_prog = 0
    with open(a.out, "w") as out:
        for i, l in enumerate(open(os.path.join(a.train_dir, "train-programmatic.jsonl"))):
            ep = json.loads(l)
            if i < a.api_plans and ep["id"] in api:
                out.write(json.dumps(api[ep["id"]]) + "\n"); n_api += 1
            else:
                out.write(l if l.endswith("\n") else l + "\n"); n_prog += 1
    print(json.dumps({"episodes": n_api + n_prog, "api_wording": n_api, "programmatic_wording": n_prog}))


if __name__ == "__main__":
    main()
