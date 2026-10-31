"""Fine-tune an encoder (Ettin / ModernBERT / mmBERT) with the Decide heads.

  python train_encoder.py --model jhu-clsp/ettin-encoder-150m --train train.spans.jsonl \
      --val val.spans.jsonl --out runs/ettin150-s1 --epochs 3 --seed 1

Writes <out>/backbone (Hugging Face format, for GGUF conversion), heads.pt,
config.json (labels, temperatures, validation scores) and train-log.jsonl.
Runs on CPU (slow but works) or GPU.
"""
import argparse
import json
import math
import os
import random
import sys
import time
from collections import Counter

import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dtw_model import ABOUTS, CERTS, KINDS, RELS, TAGS, DecideEncoder, decode_tags, example_loss  # noqa: E402


def load(path, limit=0):
    rows = [json.loads(l) for l in open(path, encoding="utf-8")]
    return rows[:limit] if limit else rows


def to_tokens(tok, ex, max_len):
    """Tokenise one record; map char spans, event ranges and memory markers to token ranges."""
    enc = tok(ex["text"], return_offsets_mapping=True, truncation=True, max_length=max_len)
    offs = enc["offset_mapping"]
    n = len(offs)

    def tok_range(a, b):
        idx = [i for i, (s, e) in enumerate(offs) if e > s and s < b and e > a]
        return (idx[0], idx[-1] + 1) if idx else None

    event_mask = [0] * n
    for ev in ex["events"]:
        r = tok_range(ev["start"], ev["end"])
        if r:
            for i in range(*r):
                event_mask[i] = 1
    tags = [0] * n
    tok_spans = []
    for sp in ex["spans"]:
        r = tok_range(sp["start"], sp["end"])
        if not r:
            continue
        b, i = TAGS.index(f"B-{sp['type'].upper()}"), TAGS.index(f"I-{sp['type'].upper()}")
        tags[r[0]] = b
        for k in range(r[0] + 1, r[1]):
            tags[k] = i
        tok_spans.append({**sp, "a": r[0], "b": r[1]})
    tok_mems = [r for r in (tok_range(m["start"], m["end"]) for m in ex["mems"]) if r]
    return {"input_ids": enc["input_ids"], "tags": tags, "event_mask": event_mask, "tok_spans": tok_spans,
            "tok_mems": tok_mems if len(tok_mems) == len(ex["mems"]) else [], "gate": ex["gate"], "id": ex["id"], "offsets": offs}


def class_weights(rows, key, labels):
    c = Counter(sp[key] for r in rows for sp in r["tok_spans"] if sp["type"] == "obs")
    w = [1.0 / math.sqrt(max(1, c[l])) for l in labels]
    s = sum(w) / len(w)
    return torch.tensor([x / s for x in w])


def batches(rows, bs, shuffle):
    idx = list(range(len(rows)))
    if not shuffle:
        idx.sort(key=lambda i: len(rows[i]["input_ids"]))
        for i in range(0, len(idx), bs):
            yield [rows[j] for j in idx[i:i + bs]]
        return
    # Shuffle, then sort within chunks of 20 batches so a batch holds similar lengths (less padding).
    random.shuffle(idx)
    out = []
    for c in range(0, len(idx), bs * 20):
        chunk = sorted(idx[c:c + bs * 20], key=lambda i: len(rows[i]["input_ids"]))
        out += [chunk[i:i + bs] for i in range(0, len(chunk), bs)]
    random.shuffle(out)
    for b in out:
        yield [rows[j] for j in b]


DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# bf16 where the GPU has it (A100, L4, H100); fp16 + loss scaling on T4 (Kaggle).
AMP = torch.bfloat16 if DEVICE == "cuda" and torch.cuda.is_bf16_supported() else torch.float16
CTX = "cls"  # whole-input vector: [CLS] (encoders) or "mean" of the event tokens (causal models)


def ctx_vec(h, event_mask):
    if CTX == "mean":
        m = torch.tensor(event_mask, dtype=torch.bool, device=h.device)
        return h[m].mean(0) if m.any() else h.mean(0)
    return h[0]


def forward(model, batch, pad_id):
    T = max(len(r["input_ids"]) for r in batch)
    ids = torch.full((len(batch), T), pad_id, dtype=torch.long)
    att = torch.zeros((len(batch), T), dtype=torch.long)
    for k, r in enumerate(batch):
        ids[k, :len(r["input_ids"])] = torch.tensor(r["input_ids"])
        att[k, :len(r["input_ids"])] = 1
    with torch.autocast(DEVICE, dtype=AMP, enabled=DEVICE == "cuda"):
        h = model.states(ids.to(DEVICE), att.to(DEVICE))
    return h.float()


@torch.no_grad()
def evaluate(model, rows, pad_id, bs=16):
    model.eval()
    c = Counter()
    kind_logits, kind_y, cert_logits, cert_y = [], [], [], []
    for batch in batches(rows, bs, False):
        H = forward(model, batch, pad_id)
        for k, r in enumerate(batch):
            n = len(r["input_ids"])
            h = H[k, :n]
            ctx = ctx_vec(h, r["event_mask"])
            pred_tags = model.heads.tag(h).argmax(-1).tolist()
            pred = {(t, a, b) for t, a, b in decode_tags(pred_tags, r["event_mask"])}
            gold = {(s["type"].upper(), s["a"], s["b"]) for s in r["tok_spans"]}
            c["span_tp"] += len(pred & gold)
            c["span_pred"] += len(pred)
            c["span_gold"] += len(gold)
            g = torch.sigmoid(model.heads.gate(ctx)).item() > 0.5
            c["gate_ok"] += int(g == bool(r["gate"]))
            c["n"] += 1
            for sp in r["tok_spans"]:
                if sp["type"] != "obs":
                    continue
                o = model.heads.span_out(h, ctx, sp["a"], sp["b"])
                kind_logits.append(o["kind"])
                kind_y.append(KINDS.index(sp["kind"]))
                cert_logits.append(o["cert"])
                cert_y.append(CERTS.index(sp["certainty"]))
                c["obs"] += 1
                c["kind_ok"] += int(o["kind"].argmax().item() == kind_y[-1])
                c["cert_ok"] += int(o["cert"].argmax().item() == cert_y[-1])
                c["imp_abs"] += abs(o["imp"].item() - sp["importance"])
                if r["tok_mems"]:
                    logits, rels = model.heads.merge_out(h, sp["a"], sp["b"], r["tok_mems"])
                    t = logits.argmax().item()
                    c["merge_n"] += 1
                    c["merge_ok"] += int(t == sp["merge"] + 1)
                    if sp["merge"] >= 0 and sp["relation"] in RELS:
                        c["rel_n"] += 1
                        c["rel_ok"] += int(rels[sp["merge"]].argmax().item() == RELS.index(sp["relation"]))
    P = c["span_tp"] / max(1, c["span_pred"])
    R = c["span_tp"] / max(1, c["span_gold"])
    res = {"span_f1": round(2 * P * R / max(1e-9, P + R), 4), "kind_acc": round(c["kind_ok"] / max(1, c["obs"]), 4),
           "cert_acc": round(c["cert_ok"] / max(1, c["obs"]), 4), "imp_mae": round(c["imp_abs"] / max(1, c["obs"]), 4),
           "merge_acc": round(c["merge_ok"] / max(1, c["merge_n"]), 4), "rel_acc": round(c["rel_ok"] / max(1, c["rel_n"]), 4),
           "gate_acc": round(c["gate_ok"] / max(1, c["n"]), 4)}
    model.train()
    return res, (torch.stack(kind_logits) if kind_logits else None, torch.tensor(kind_y), torch.stack(cert_logits) if cert_logits else None, torch.tensor(cert_y))


def fit_temperature(logits, y):
    """Scalar temperature minimising NLL on held-out logits."""
    if logits is None or not len(y):
        return 1.0
    best, bt = None, 1.0
    for t in [0.5 + 0.05 * i for i in range(60)]:
        nll = F.cross_entropy(logits / t, y).item()
        if best is None or nll < best:
            best, bt = nll, t
    return round(bt, 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--head-lr", type=float, default=1e-3)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--val-limit", type=int, default=400)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--freeze-embeddings", action="store_true", help="for large-vocabulary models (mmBERT) on CPU")
    ap.add_argument("--causal", action="store_true", help="a decoder backbone (LFM3): last hidden states, mean context")
    ap.add_argument("--trust-remote-code", action="store_true")
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank on the backbone (0 = full fine-tuning)")
    ap.add_argument("--lora-targets", default="q_proj,k_proj,v_proj,o_proj,in_proj,out_proj,w1,w2,w3")
    ap.add_argument("--freeze-backbone", action="store_true", help="train the heads only")
    a = ap.parse_args()
    global CTX
    CTX = "mean" if a.causal else "cls"
    if a.threads:
        torch.set_num_threads(a.threads)
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    from transformers import AutoTokenizer, get_linear_schedule_with_warmup
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=a.trust_remote_code)
    train = [to_tokens(tok, r, a.max_len) for r in load(a.train, a.limit)]
    val = [to_tokens(tok, r, a.max_len) for r in load(a.val, a.val_limit)]
    print(f"train {len(train)} val {len(val)} longest {max(len(r['input_ids']) for r in train)} tokens", flush=True)
    model = DecideEncoder(a.model, causal=a.causal, trust_remote_code=a.trust_remote_code)
    if a.lora:
        from peft import LoraConfig, get_peft_model
        model.backbone = get_peft_model(model.backbone, LoraConfig(r=a.lora, lora_alpha=2 * a.lora, lora_dropout=0.05, target_modules=a.lora_targets.split(",")))
        model.backbone.print_trainable_parameters()
    if a.freeze_backbone:
        for p in model.backbone.parameters():
            p.requires_grad = False
    model.to(DEVICE)
    if a.freeze_embeddings:
        for p in model.backbone.embeddings.parameters():
            p.requires_grad = False
    weights = {"kind": class_weights(train, "kind", KINDS).to(DEVICE), "cert": class_weights(train, "certainty", CERTS).to(DEVICE),
               "tag": torch.tensor([0.3, 1.0, 1.0, 1.0, 1.0], device=DEVICE)}
    params = [{"params": [p for p in model.backbone.parameters() if p.requires_grad], "lr": a.lr},
              {"params": model.heads.parameters(), "lr": a.head_lr}]
    opt = torch.optim.AdamW(params, weight_decay=0.01)
    steps = a.epochs * math.ceil(len(train) / a.bs)
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    os.makedirs(a.out, exist_ok=True)
    log = open(os.path.join(a.out, "train-log.jsonl"), "w")
    scaler = torch.amp.GradScaler(enabled=DEVICE == "cuda" and AMP == torch.float16)
    pad = tok.pad_token_id if tok.pad_token_id is not None else 0
    best, step, t0 = None, 0, time.time()
    for ep in range(a.epochs):
        for batch in batches(train, a.bs, True):
            H = forward(model, batch, pad)
            losses = []
            for k, r in enumerate(batch):
                n = len(r["input_ids"])
                h = H[k, :n]
                losses.append(example_loss(model.heads, h, ctx_vec(h, r["event_mask"]), r, torch.tensor(r["tags"], device=DEVICE), torch.tensor(r["event_mask"], device=DEVICE), weights)["total"])
            loss = torch.stack(losses).mean()
            opt.zero_grad()
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            step += 1
            if step % 20 == 0:
                rec = {"step": step, "epoch": ep, "loss": round(loss.item(), 4), "sec": round(time.time() - t0)}
                log.write(json.dumps(rec) + "\n")
                log.flush()
                print(rec, flush=True)
        res, (kl, ky, cl, cy) = evaluate(model, val, pad)
        res.update({"epoch": ep, "sec": round(time.time() - t0)})
        log.write(json.dumps({"val": res}) + "\n")
        log.flush()
        print("val", res, flush=True)
        score = res["span_f1"] + res["kind_acc"] + res["cert_acc"] + res["merge_acc"] + res["gate_acc"]
        if best is None or score > best[0]:
            best = (score, res, fit_temperature(kl, ky), fit_temperature(cl, cy))
            # LoRA: keep the best adapter; it is merged into the base once training ends.
            model.backbone.save_pretrained(os.path.join(a.out, "adapter" if a.lora else "backbone"))
            tok.save_pretrained(os.path.join(a.out, "backbone"))
            torch.save(model.heads.state_dict(), os.path.join(a.out, "heads.pt"))
    if a.lora:
        from peft import PeftModel
        base = DecideEncoder(a.model, causal=a.causal, trust_remote_code=a.trust_remote_code).backbone
        PeftModel.from_pretrained(base, os.path.join(a.out, "adapter")).merge_and_unload().save_pretrained(os.path.join(a.out, "backbone"))
    cfg = {"base": a.model, "hidden": model.heads.new.in_features, "ctx": CTX, "tags": TAGS, "kinds": KINDS, "certs": CERTS, "abouts": ABOUTS,
           "rels": RELS, "temperature": {"kind": best[2], "cert": best[3]}, "val": best[1], "args": vars(a),
           "train_seconds": round(time.time() - t0)}
    json.dump(cfg, open(os.path.join(a.out, "config.json"), "w"), indent=1)
    print("done", json.dumps(cfg["val"]), flush=True)


if __name__ == "__main__":
    main()
