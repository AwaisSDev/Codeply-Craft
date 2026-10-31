"""Train the Decide heads on frozen LFM3 token states (lfm3_features.py).

The same heads, losses, class weights and validation as train_encoder.py;
only the token states differ (LFM3-1.7B QAD Q4_0 through llama.cpp, frozen).
LFM3 is causal, so the whole-input vector is the mean of the event tokens'
states instead of a [CLS] state.

  python train_lfm3_heads.py --train-feat train --train train.spans.jsonl \
      --val-feat val --val val.spans.jsonl --out runs/lfm3-heads-s1
"""
import argparse
import json
import os
import random
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dtw_model import ABOUTS, CERTS, KINDS, RELS, TAGS, DecideHeads, example_loss  # noqa: E402
import train_encoder as TE  # noqa: E402


class Feats:
    def __init__(self, prefix):
        self.index = {r["id"]: r for r in json.load(open(prefix + ".index.json"))}
        self.mm = np.memmap(prefix + ".f16", dtype=np.float16, mode="r")

    def get(self, id_):
        r = self.index[id_]
        return torch.from_numpy(np.array(self.mm[r["offset"]:r["offset"] + r["n"] * r["dim"]], dtype=np.float32).reshape(r["n"], r["dim"])), r["offsets"]


class OffsetTok:
    """Looks like a Hugging Face tokenizer call, but returns the stored llama.cpp offsets."""

    def __init__(self, offsets):
        self.offsets = offsets

    def __call__(self, text, **kw):
        return {"input_ids": list(range(len(self.offsets))), "offset_mapping": [tuple(o) for o in self.offsets]}


def prepare(rows, feats):
    out = []
    for r in rows:
        if r["id"] not in feats.index:
            continue
        H, offs = feats.get(r["id"])
        ex = TE.to_tokens(OffsetTok(offs), r, 4096)
        ex["H"] = H.half()
        out.append(ex)
    return out


def ctx_of(H, mask):
    m = torch.tensor(mask, dtype=torch.bool)
    return H[m].mean(0) if m.any() else H.mean(0)


class FrozenModel(torch.nn.Module):
    """Adapter so train_encoder.evaluate() can score heads on stored states."""

    def __init__(self, heads):
        super().__init__()
        self.heads = heads


@torch.no_grad()
def evaluate(heads, rows):
    heads.eval()
    from collections import Counter
    from dtw_model import decode_tags
    c = Counter()
    for r in rows:
        h = r["H"].float()
        ctx = ctx_of(h, r["event_mask"])
        pred = {(t, a, b) for t, a, b in decode_tags(heads.tag(h).argmax(-1).tolist(), r["event_mask"])}
        gold = {(s["type"].upper(), s["a"], s["b"]) for s in r["tok_spans"]}
        c["tp"] += len(pred & gold); c["p"] += len(pred); c["g"] += len(gold)
        c["gate_ok"] += int((torch.sigmoid(heads.gate(ctx)).item() > 0.5) == bool(r["gate"])); c["n"] += 1
        for sp in r["tok_spans"]:
            if sp["type"] != "obs":
                continue
            o = heads.span_out(h, ctx, sp["a"], sp["b"])
            c["obs"] += 1
            c["kind_ok"] += int(o["kind"].argmax().item() == KINDS.index(sp["kind"]))
            c["cert_ok"] += int(o["cert"].argmax().item() == CERTS.index(sp["certainty"]))
            if r["tok_mems"]:
                lg, rels = heads.merge_out(h, sp["a"], sp["b"], r["tok_mems"])
                c["mn"] += 1; c["mok"] += int(lg.argmax().item() == sp["merge"] + 1)
    heads.train()
    P, R = c["tp"] / max(1, c["p"]), c["tp"] / max(1, c["g"])
    return {"span_f1": round(2 * P * R / max(1e-9, P + R), 4), "kind_acc": round(c["kind_ok"] / max(1, c["obs"]), 4),
            "cert_acc": round(c["cert_ok"] / max(1, c["obs"]), 4), "merge_acc": round(c["mok"] / max(1, c["mn"]), 4),
            "gate_acc": round(c["gate_ok"] / max(1, c["n"]), 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-feat", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--val-feat", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    train = prepare(TE.load(a.train), Feats(a.train_feat))
    val = prepare(TE.load(a.val), Feats(a.val_feat))
    hidden = train[0]["H"].shape[1]
    print(f"train {len(train)} val {len(val)} hidden {hidden}", flush=True)
    heads = DecideHeads(hidden)
    weights = {"kind": TE.class_weights(train, "kind", KINDS), "cert": TE.class_weights(train, "certainty", CERTS), "tag": torch.tensor([0.3, 1.0, 1.0, 1.0, 1.0])}
    opt = torch.optim.AdamW(heads.parameters(), lr=a.lr, weight_decay=0.01)
    os.makedirs(a.out, exist_ok=True)
    log = open(os.path.join(a.out, "train-log.jsonl"), "w")
    best, t0 = None, time.time()
    for ep in range(a.epochs):
        random.shuffle(train)
        for i in range(0, len(train), a.bs):
            losses = []
            for r in train[i:i + a.bs]:
                h = r["H"].float()
                losses.append(example_loss(heads, h, ctx_of(h, r["event_mask"]), r, torch.tensor(r["tags"]), torch.tensor(r["event_mask"]), weights)["total"])
            loss = torch.stack(losses).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        res = evaluate(heads, val)
        res.update({"epoch": ep, "loss": round(loss.item(), 4), "sec": round(time.time() - t0)})
        print("val", res, flush=True)
        log.write(json.dumps({"val": res}) + "\n"); log.flush()
        score = res["span_f1"] + res["kind_acc"] + res["cert_acc"] + res["merge_acc"] + res["gate_acc"]
        if best is None or score > best[0]:
            best = (score, res)
            torch.save(heads.state_dict(), os.path.join(a.out, "heads.pt"))
    cfg = {"base": "lfm3-1.7b-qad-q4 (frozen, llama.cpp)", "hidden": hidden, "ctx": "mean", "tags": TAGS, "kinds": KINDS, "certs": CERTS, "abouts": ABOUTS,
           "rels": RELS, "temperature": {"kind": 1.0, "cert": 1.0}, "val": best[1], "args": vars(a), "train_seconds": round(time.time() - t0)}
    json.dump(cfg, open(os.path.join(a.out, "config.json"), "w"), indent=1)
    print("done", json.dumps(best[1]))


if __name__ == "__main__":
    main()
