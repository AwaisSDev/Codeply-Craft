"""LoRA fine-tuning of a small base model for Codeply's context-intelligence task.

Runs on a rented GPU (see ml/finetune/README.md). The data is the chat-format
SFT export (ml/data/export-sft.mjs), rendered with the exact runtime prompt.
Only the assistant answer (the JSON) is trained on; the prompt is masked.

    python ml/finetune/train_lora.py --config ml/finetune/config.yaml
    python ml/finetune/train_lora.py --config ml/finetune/config.yaml --smoke   # 2 steps, tiny model, CPU ok

Output: <output_dir>/adapter (LoRA) and <output_dir>/merged (full weights,
ready for llama.cpp's convert_hf_to_gguf.py, see export_gguf.sh).
"""
import argparse
import json
import math
import os
import random
import time

import yaml


def load_rows(path, limit=0):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line)["messages"])
            if limit and len(rows) >= limit:
                break
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="ml/finetune/config.yaml")
    ap.add_argument("--smoke", action="store_true", help="2 steps on a tiny model to check the pipeline")
    a = ap.parse_args()
    cfg = yaml.safe_load(open(a.config, encoding="utf-8"))
    if a.smoke:
        cfg.update(cfg.get("smoke", {}))

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    random.seed(cfg.get("seed", 7))
    torch.manual_seed(cfg.get("seed", 7))
    use_cuda = torch.cuda.is_available()
    dtype = torch.bfloat16 if use_cuda and torch.cuda.is_bf16_supported() else (torch.float16 if use_cuda else torch.float32)
    device = "cuda" if use_cuda else "cpu"

    tok = AutoTokenizer.from_pretrained(cfg["base_model"])
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    template_kwargs = cfg.get("chat_template_kwargs") or {}

    def encode(messages):
        """Tokens of the whole chat; labels only on the assistant answer (and its end token)."""
        prompt = tok.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, **template_kwargs)
        full = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, **template_kwargs)
        if not full.startswith(prompt):
            # Some templates render the last turn differently; fall back to prompt + answer + eos.
            full = prompt + messages[-1]["content"] + (tok.eos_token or "")
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
        f_ids = tok(full, add_special_tokens=False)["input_ids"][: cfg["max_seq_len"]]
        labels = [-100] * min(len(p_ids), len(f_ids)) + f_ids[len(p_ids):]
        return {"input_ids": f_ids, "labels": labels[: len(f_ids)]}

    train = [encode(m) for m in load_rows(cfg["train_file"], cfg.get("train_limit", 0))]
    val = [encode(m) for m in load_rows(cfg["val_file"], cfg.get("val_limit", 0))]
    train = [x for x in train if any(l != -100 for l in x["labels"])]
    print(f"train {len(train)}  val {len(val)}  longest {max(len(x['input_ids']) for x in train)} tokens", flush=True)

    model = AutoModelForCausalLM.from_pretrained(cfg["base_model"], dtype=dtype)
    if cfg.get("gradient_checkpointing") and use_cuda:
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    lora = LoraConfig(r=cfg["lora"]["r"], lora_alpha=cfg["lora"]["alpha"], lora_dropout=cfg["lora"]["dropout"],
                      target_modules=cfg["lora"]["target_modules"], task_type="CAUSAL_LM")
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    model.to(device)

    def batches(data, bs, shuffle):
        idx = list(range(len(data)))
        if shuffle:
            random.shuffle(idx)
        for i in range(0, len(idx), bs):
            chunk = [data[j] for j in idx[i:i + bs]]
            n = max(len(x["input_ids"]) for x in chunk)
            ids = torch.full((len(chunk), n), tok.pad_token_id)
            lab = torch.full((len(chunk), n), -100)
            att = torch.zeros((len(chunk), n), dtype=torch.long)
            for k, x in enumerate(chunk):
                L = len(x["input_ids"])
                ids[k, :L] = torch.tensor(x["input_ids"])
                lab[k, :L] = torch.tensor(x["labels"])
                att[k, :L] = 1
            yield ids.to(device), lab.to(device), att.to(device)

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=cfg["learning_rate"], weight_decay=cfg.get("weight_decay", 0.0))
    steps_per_epoch = math.ceil(len(train) / cfg["batch_size"] / cfg["grad_accum"])
    total = cfg.get("max_steps") or steps_per_epoch * cfg["epochs"]
    warm = max(1, int(total * cfg.get("warmup_ratio", 0.03)))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / max(1, total)))))

    def evaluate():
        model.eval()
        tot, n = 0.0, 0
        with torch.no_grad():
            for ids, lab, att in batches(val, cfg["batch_size"], False):
                tot += model(input_ids=ids, attention_mask=att, labels=lab).loss.item()
                n += 1
        model.train()
        return tot / max(1, n)

    os.makedirs(cfg["output_dir"], exist_ok=True)
    log = open(os.path.join(cfg["output_dir"], "train-log.jsonl"), "a", encoding="utf-8")
    step, t0 = 0, time.time()
    model.train()
    done = False
    for epoch in range(cfg["epochs"]):
        for k, (ids, lab, att) in enumerate(batches(train, cfg["batch_size"], True)):
            loss = model(input_ids=ids, attention_mask=att, labels=lab).loss / cfg["grad_accum"]
            loss.backward()
            if (k + 1) % cfg["grad_accum"]:
                continue
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad()
            step += 1
            if step % cfg.get("log_every", 10) == 0 or step == 1:
                rec = {"step": step, "epoch": epoch, "loss": round(loss.item() * cfg["grad_accum"], 4), "lr": sched.get_last_lr()[0], "s": round(time.time() - t0)}
                print(json.dumps(rec), flush=True); log.write(json.dumps(rec) + "\n")
            if cfg.get("eval_every") and step % cfg["eval_every"] == 0:
                rec = {"step": step, "val_loss": round(evaluate(), 4)}
                print(json.dumps(rec), flush=True); log.write(json.dumps(rec) + "\n")
            if step >= total:
                done = True
                break
        if done:
            break
    rec = {"step": step, "final_val_loss": round(evaluate(), 4), "seconds": round(time.time() - t0)}
    print(json.dumps(rec), flush=True); log.write(json.dumps(rec) + "\n"); log.close()

    model.save_pretrained(os.path.join(cfg["output_dir"], "adapter"))
    merged = model.merge_and_unload()
    merged_dir = os.path.join(cfg["output_dir"], "merged")
    merged.save_pretrained(merged_dir, safe_serialization=True)
    tok.save_pretrained(merged_dir)
    copy_base_tokenizer(cfg["base_model"], merged_dir)
    print("saved", cfg["output_dir"])


def copy_base_tokenizer(base_model, merged_dir):
    """LoRA never changes the tokenizer. Ship the base model's own tokenizer files,
    not the re-saved ones: llama.cpp's converter pins an older transformers that
    cannot read every newer tokenizer_config.json (found in the smoke run)."""
    import shutil
    try:
        from huggingface_hub import snapshot_download
        src = base_model if os.path.isdir(base_model) else snapshot_download(
            base_model, allow_patterns=["tokenizer*", "special_tokens_map.json", "vocab*", "merges.txt", "*.model", "chat_template*"])
        for name in os.listdir(src):
            if name.startswith(("tokenizer", "special_tokens_map", "vocab", "merges", "chat_template")) or name.endswith(".model"):
                shutil.copy(os.path.join(src, name), os.path.join(merged_dir, name))
    except Exception as e:  # keep the re-saved tokenizer rather than fail a finished run
        print("could not copy the base tokenizer:", e)


if __name__ == "__main__":
    main()
