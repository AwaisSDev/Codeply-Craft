#!/usr/bin/env python3
"""Merge a trained LoRA adapter into LFM3-1.7B exactly as ml/finetune/train_lora.py does after training:
base in fp16, PEFT merge_and_unload, save_pretrained (safetensors), the base model's own tokenizer files.

The base revision is pinned to the one current when the adapters were trained (Kaggle LoRA run 4,
2026-11-01): LiquidAI/LFM3-1.7B @ ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7.

  python release/memory-model/merge_adapter.py <adapter_dir> <out_dir>
"""
import os, sys

BASE = "LiquidAI/LFM3-1.7B"
REVISION = "ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7"


def main():
    adapter, out = sys.argv[1], sys.argv[2]
    if os.path.exists(os.path.join(out, "model.safetensors")):
        print("already merged:", out); return
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml", "finetune"))
    from train_lora import copy_base_tokenizer
    model = AutoModelForCausalLM.from_pretrained(BASE, revision=REVISION, dtype=torch.float16, trust_remote_code=True)
    model = PeftModel.from_pretrained(model, adapter).merge_and_unload()
    tmp = out + ".part"
    model.save_pretrained(tmp, safe_serialization=True)
    AutoTokenizer.from_pretrained(BASE, revision=REVISION, trust_remote_code=True).save_pretrained(tmp)
    copy_base_tokenizer(BASE, tmp)
    os.replace(tmp, out)
    print("merged", adapter, "->", out)


if __name__ == "__main__":
    main()
