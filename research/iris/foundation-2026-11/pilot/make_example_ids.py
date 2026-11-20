#!/usr/bin/env python3
"""Shared example list for the matched LoRA pilot (EVAL-PLAN A4). Read-only on the data; writes example-ids.json.

Train: data/built/train.jsonl without the drill shard (syn01), kept only if the example fits max_tokens in ALL three
models' chat templates (system line prompt.SYSTEM, the pilot's template switches). Val: data/built/val.jsonl shuffled
with random.Random(0) (as r2), then the first 120 that fit in all three. Every model trains and selects checkpoints on
exactly these ids. Needs `transformers` (tokenizers only, no torch).

    cd research/iris && python3 foundation-2026-11/pilot/make_example_ids.py
"""
import hashlib
import json
import random
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
from transformers import AutoTokenizer  # noqa: E402  (before any torch stub: transformers caches torch availability)
if "torch" not in sys.modules:                       # train.py imports torch at module level; only its text helpers are used
    try:
        import torch  # noqa: F401
    except ImportError:
        import importlib.machinery
        stub = types.ModuleType("torch")
        stub.__spec__ = importlib.machinery.ModuleSpec("torch", None)
        sys.modules["torch"] = stub
from codeply_iris import train as T  # noqa: E402

MODELS = {"qwen3-1.7b": ("Qwen/Qwen3-1.7B", {"enable_thinking": False}),
          "qwen3-4b-2507": ("Qwen/Qwen3-4B-Instruct-2507", {}),
          "gemma-4-e2b": ("google/gemma-4-E2B-it", {"enable_thinking": False})}
MAX_TOKENS = 2048
EXCLUDE = {"syn01"}
VAL_N = 120


def main():
    toks = {k: (AutoTokenizer.from_pretrained(hf), kw) for k, (hf, kw) in MODELS.items()}
    load = lambda p: [json.loads(l) for l in (ROOT / p).read_text(encoding="utf-8").splitlines() if l.strip()]
    train, val = load("data/built/train.jsonl"), load("data/built/val.jsonl")
    assert len({e["id"] for e in train}) == len(train) and len({e["id"] for e in val}) == len(val), "ids not unique"

    def lengths(ex):
        return {k: len(T.template_ids(tok, ex["prompt"], ex["target"], kw)[0]) for k, (tok, kw) in toks.items()}

    stats = {"train_candidates": 0, "train_dropped_too_long": {}, "train_tokens": {k: 0 for k in MODELS}}
    keep_train = []
    for ex in train:
        if ex["shard"] in EXCLUDE:
            continue
        stats["train_candidates"] += 1
        n = lengths(ex)
        if max(n.values()) > MAX_TOKENS:
            stats["train_dropped_too_long"][ex["id"]] = n
            continue
        keep_train.append(ex["id"])
        for k, v in n.items():
            stats["train_tokens"][k] += v
    vex = list(val)
    random.Random(0).shuffle(vex)
    keep_val = []
    for ex in vex:
        if max(lengths(ex).values()) <= MAX_TOKENS:
            keep_val.append(ex["id"])
        if len(keep_val) == VAL_N:
            break
    sha = lambda ids: hashlib.sha256("\n".join(ids).encode()).hexdigest()
    out = {"max_tokens": MAX_TOKENS, "exclude_shards": sorted(EXCLUDE), "models": {k: [hf, kw] for k, (hf, kw) in MODELS.items()},
           "train_file_sha256": hashlib.sha256((ROOT / "data/built/train.jsonl").read_bytes()).hexdigest(),
           "val_file_sha256": hashlib.sha256((ROOT / "data/built/val.jsonl").read_bytes()).hexdigest(),
           "train": keep_train, "val": keep_val, "train_ids_sha256": sha(keep_train), "val_ids_sha256": sha(keep_val), "stats": stats}
    (HERE / "example-ids.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k not in ("train", "val")}, indent=1)[:2500])
    print("train", len(keep_train), "val", len(keep_val))


if __name__ == "__main__":
    main()
