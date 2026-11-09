"""LoRA fine-tuning of the Iris foundation on built examples. Runs on CPU (bf16 autocast; AMX / AVX-512) or GPU.

    python -m codeply_iris.train --config train/iris-0.6b.json [--resume] [--max-minutes 110]

Design choices that matter on a 4-core, 15 GB machine:
* batch size 1 with gradient accumulation: no padding, bounded memory;
* the vocabulary projection (151k x d) is applied only at the answer positions, which is where the loss is:
  that removes most of the logits memory and about a fifth of the forward cost;
* frozen base weights in bf16, LoRA weights in fp32 under autocast: fast kernels without bf16 optimiser updates;
* everything needed to continue is saved every `save_every` optimiser steps (adapter, optimiser, scheduler,
  position in the epoch, RNG), and `--max-minutes` stops cleanly, so a run survives session limits.
"""
import argparse
import json
import math
import os
import random
import time
from pathlib import Path

import torch

from . import prompt

DEFAULTS = {
    "base": "Qwen/Qwen3-0.6B", "train": "data/built/train.jsonl", "val": "data/built/val.jsonl", "out": "runs/iris",
    "epochs": 3, "lr": 2e-4, "warmup_steps": 30, "accum": 8, "max_tokens": 1536, "seed": 1,
    "lora_r": 32, "lora_alpha": 64, "lora_dropout": 0.05,
    "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    "weight_decay": 0.0, "grad_clip": 1.0, "save_every": 25, "eval_every": 100, "val_examples": 120, "threads": 0,
    "init_adapter": "",
}


def load_examples(path):
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


def encode(tok, ex, max_tokens):
    """(input_ids, first_answer_position) for one example, or None when it does not fit."""
    p = tok(prompt.chatml(ex["prompt"]), add_special_tokens=False)["input_ids"]
    a = tok(ex["target"] + "<|im_end|>", add_special_tokens=False)["input_ids"]
    if len(p) + len(a) > max_tokens:
        return None
    return torch.tensor(p + a, dtype=torch.long), len(p)


def answer_loss(lm, ids, start):
    """Cross-entropy on the answer tokens only; the LM head runs on those positions alone."""
    h = lm.model(input_ids=ids.unsqueeze(0)).last_hidden_state[0]
    logits = lm.lm_head(h[start - 1:-1]).float()
    return torch.nn.functional.cross_entropy(logits, ids[start:])


def get_lm(model):
    """The underlying *ForCausalLM (with .model and .lm_head) inside a PEFT wrapper."""
    return model.base_model.model if hasattr(model, "base_model") and hasattr(model.base_model, "model") else model


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--max-minutes", type=float, default=0, help="stop cleanly after this long (0 = no limit)")
    ap.add_argument("--set", action="append", default=[], help="override, e.g. --set epochs=1")
    a = ap.parse_args(argv)
    cfg = dict(DEFAULTS)
    cfg.update(json.loads(Path(a.config).read_text()))
    for kv in a.set:
        k, v = kv.split("=", 1)
        cfg[k] = type(DEFAULTS[k])(v) if k in DEFAULTS and not isinstance(DEFAULTS[k], (list, str)) else v
    out = Path(cfg["out"])
    out.mkdir(parents=True, exist_ok=True)
    if cfg["threads"]:
        torch.set_num_threads(int(cfg["threads"]))
    torch.manual_seed(cfg["seed"])
    random.seed(cfg["seed"])
    device = "cuda" if torch.cuda.is_available() else "cpu"

    from peft import LoraConfig, PeftModel, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(cfg["base"])
    base = AutoModelForCausalLM.from_pretrained(cfg["base"], torch_dtype=torch.bfloat16 if device == "cpu" else torch.float16)
    ckpt = out / "ckpt"
    state = None
    if a.resume and (ckpt / "state.pt").exists():
        model = PeftModel.from_pretrained(base, str(ckpt / "adapter"), is_trainable=True)
        state = torch.load(ckpt / "state.pt", weights_only=False)
    elif cfg["init_adapter"]:
        model = PeftModel.from_pretrained(base, cfg["init_adapter"], is_trainable=True)
    else:
        model = get_peft_model(base, LoraConfig(r=cfg["lora_r"], lora_alpha=cfg["lora_alpha"], lora_dropout=cfg["lora_dropout"],
                                                target_modules=cfg["target_modules"], task_type="CAUSAL_LM"))
    for n, p in model.named_parameters():
        if p.requires_grad:
            p.data = p.data.float()
    model.to(device)
    lm = get_lm(model)
    params = [p for p in model.parameters() if p.requires_grad]

    train = [e for e in (encode(tok, ex, cfg["max_tokens"]) for ex in load_examples(cfg["train"])) if e]
    n_all = len(load_examples(cfg["train"]))
    val = []
    if cfg["val"] and Path(cfg["val"]).exists():
        vex = load_examples(cfg["val"])
        random.Random(0).shuffle(vex)
        val = [e for e in (encode(tok, ex, cfg["max_tokens"]) for ex in vex[:cfg["val_examples"]]) if e]
    steps_per_epoch = math.ceil(len(train) / cfg["accum"])
    total_steps = steps_per_epoch * cfg["epochs"]
    opt = torch.optim.AdamW(params, lr=cfg["lr"], weight_decay=cfg["weight_decay"], betas=(0.9, 0.99))

    def lr_at(step):
        if step < cfg["warmup_steps"]:
            return cfg["lr"] * (step + 1) / cfg["warmup_steps"]
        t = (step - cfg["warmup_steps"]) / max(total_steps - cfg["warmup_steps"], 1)
        return cfg["lr"] * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * min(t, 1.0))))

    step, epoch, pos, best = 0, 0, 0, float("inf")
    if state:
        opt.load_state_dict(state["opt"])
        step, epoch, pos, best = state["step"], state["epoch"], state["pos"], state.get("best", float("inf"))
    log = (out / "train-log.jsonl").open("a")
    (out / "config.json").write_text(json.dumps({**cfg, "train_examples": len(train), "dropped_too_long": n_all - len(train),
                                                 "steps_per_epoch": steps_per_epoch, "total_steps": total_steps,
                                                 "trainable_params": sum(p.numel() for p in params),
                                                 "train_tokens_per_epoch": int(sum(len(i) for i, _ in train)),
                                                 "torch": torch.__version__, "device": device}, indent=1))
    print(f"train {len(train)}/{n_all} examples, {sum(len(i) for i, _ in train)} tokens/epoch, val {len(val)}, "
          f"{total_steps} steps, resume at step {step} (epoch {epoch}, pos {pos})", flush=True)

    def ctx():
        return torch.autocast(device, dtype=torch.bfloat16 if device == "cpu" else torch.float16)

    def evaluate():
        model.eval()
        tot, n = 0.0, 0
        with torch.no_grad(), ctx():
            for ids, start in val:
                tot += answer_loss(lm, ids.to(device), start).item() * (len(ids) - start)
                n += len(ids) - start
        model.train()
        return tot / max(n, 1)

    def save(tag="ckpt"):
        d = out / tag
        model.save_pretrained(str(d / "adapter"))
        if tag == "ckpt":
            torch.save({"opt": opt.state_dict(), "step": step, "epoch": epoch, "pos": pos, "best": best}, d / "state.tmp")
            os.replace(d / "state.tmp", d / "state.pt")

    t0, tok_seen, run_loss, run_n = time.time(), 0, 0.0, 0
    model.train()
    stop = False
    while epoch < cfg["epochs"] and not stop:
        order = list(range(len(train)))
        random.Random(cfg["seed"] * 1000 + epoch).shuffle(order)
        while pos < len(order):
            batch = order[pos:pos + cfg["accum"]]
            for g in opt.param_groups:
                g["lr"] = lr_at(step)
            for i in batch:
                ids, start = train[i]
                with ctx():
                    loss = answer_loss(lm, ids.to(device), start)
                (loss / len(batch)).backward()
                run_loss += loss.item()
                run_n += 1
                tok_seen += len(ids)
            torch.nn.utils.clip_grad_norm_(params, cfg["grad_clip"])
            opt.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            pos += len(batch)
            if step % 5 == 0:
                rec = {"step": step, "epoch": round(epoch + pos / len(order), 3), "loss": round(run_loss / run_n, 4),
                       "lr": round(lr_at(step), 7), "tok_s": round(tok_seen / (time.time() - t0)), "min": round((time.time() - t0) / 60, 1)}
                log.write(json.dumps(rec) + "\n")
                log.flush()
                print(rec, flush=True)
                run_loss, run_n = 0.0, 0
            if val and step % cfg["eval_every"] == 0:
                vl = evaluate()
                rec = {"step": step, "val_loss": round(vl, 4)}
                if vl < best:
                    best = vl
                    save("best")
                    rec["best"] = True
                log.write(json.dumps(rec) + "\n")
                log.flush()
                print(rec, flush=True)
            if step % cfg["save_every"] == 0:
                save()
            if a.max_minutes and (time.time() - t0) / 60 >= a.max_minutes:
                stop = True
                break
        if not stop:
            epoch += 1
            pos = 0
    save()
    if not stop:
        if val:
            vl = evaluate()
            log.write(json.dumps({"step": step, "val_loss": round(vl, 4), "final": True}) + "\n")
            if vl < best:
                best = vl
                save("best")
        save("final")
        (out / "DONE").write_text(json.dumps({"steps": step, "best_val_loss": best, "minutes": round((time.time() - t0) / 60, 1)}))
    print("stopped" if stop else "finished", "at step", step, flush=True)


if __name__ == "__main__":
    main()
