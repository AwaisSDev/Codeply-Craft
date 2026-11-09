"""Dataset checks for iris.v1 example files (DATA.md §4). Every check is deterministic; a release needs all to pass.

    python -m irisarch.checks train.jsonl val.jsonl [test.jsonl ...]

  gold         every gold output is valid and grounded in its own request (contract.validate + verify_evidence)
  duplicates   no two examples share the same request (hash of the request JSON)
  leakage      no person / organisation / project name and no event text is shared between files of different splits
  balance      op mix, share of empty answers (doing nothing), share of noisy-history examples, render kinds
  plain        no `plain` render in a file meant for training or evaluation numbers (pipeline-test renders only)
"""
import collections
import hashlib
import json
import sys

from . import contract as C


def load(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def _hash(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def _names(ex):
    out = {e["name"] for e in ex["request"].get("entities", []) if e.get("type") != "user"}
    out |= {m.get("entity") for m in ex["request"].get("memories", []) if m.get("entity") not in (None, "user")}
    return out


def run(paths, allow_plain=False):
    report, failures = {}, []
    by_split, texts = collections.defaultdict(set), collections.defaultdict(set)
    seen = {}
    for p in paths:
        rows = load(p)
        ops, renders = collections.Counter(), collections.Counter()
        empty = noisy = 0
        for ex in rows:
            errs = C.validate(ex["gold"], ex["request"]) + C.verify_evidence(ex["gold"], ex["request"])
            if errs:
                failures.append(f"gold {ex['id']}: {errs[:2]}")
            h = _hash(ex["request"])
            if h in seen:
                failures.append(f"duplicate request {ex['id']} = {seen[h]}")
            seen[h] = ex["id"]
            split = ex.get("split", "?")
            by_split[split] |= _names(ex)
            g0 = ex["gold"]
            if g0.get("items") or g0.get("plans") or g0.get("relations"):   # a shared text only leaks if it carries labels
                texts[split] |= {e["text"] for e in ex["request"].get("events", [])}
            renders[ex.get("render")] += 1
            g = ex["gold"]
            for it in g.get("items", []):
                ops[it["op"]] += 1
            if ex["request"]["mode"] == "observe" and not (g.get("items") or g.get("plans") or g.get("relations")):
                empty += 1
            if any(str(m["id"]).startswith("m") and m.get("slot", "").endswith("(noted)") for m in ex["request"].get("memories", [])):
                noisy += 1
            if ex.get("render") == "plain" and not allow_plain:
                failures.append(f"plain render in {p}: {ex['id']} (pipeline tests only)")
                break
        n_obs = sum(1 for ex in rows if ex["request"]["mode"] == "observe")
        report[p] = {"examples": len(rows), "observe": n_obs, "retrieve": len(rows) - n_obs, "ops": dict(ops),
                     "empty_share": round(empty / max(1, n_obs), 3), "noisy_share": round(noisy / max(1, n_obs), 3),
                     "renders": dict(renders)}
    splits = sorted(by_split)
    for i, a in enumerate(splits):
        for b in splits[i + 1:]:
            shared = by_split[a] & by_split[b]
            if shared:
                failures.append(f"names shared by {a} and {b}: {sorted(shared)[:8]}")
            st = texts[a] & texts[b]
            if st:
                failures.append(f"{len(st)} labelled event texts shared by {a} and {b}: {sorted(st)[:3]}")
    return report, failures


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    allow_plain = "--allow-plain" in argv
    paths = [a for a in argv if not a.startswith("--")]
    report, failures = run(paths, allow_plain)
    print(json.dumps({"report": report, "failures": failures[:50], "ok": not failures}, indent=1))
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
