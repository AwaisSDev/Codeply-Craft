"""Kaggle notebooks for the model-selection experiment on the realistic data
(research/dtw/MODEL-SELECTION-PROTOCOL.md). Both read the frozen split in
research/dtw/data/real/ from the public branch.

  python3 research/dtw/notebooks/make_notebooks_real.py

real-encoders.ipynb    Ettin-150M x 3 seeds, Ettin-400M x 1 seed + Decide heads; GGUF Q8_0 / Q4_0 + heads
real-lfm3-lora.ipynb   LFM3-1.7B LoRA (production fine-tuning script and prompt), seeds from SEEDS; GGUF
Settings: GPU (T4 x2 or P100), Internet on.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LLAMA = "aa588a3463357ee990b314f41dda242869130704"

SETUP = r'''# Setup: the experiment branch (public), dependencies, the frozen split
import os, subprocess, hashlib, json
if not os.path.exists("/kaggle/working/codeply"):
    subprocess.run(["git", "clone", "--depth", "1", "-b", "codeply-li-dtw-experiment",
                    "https://github.com/AwaisSDev/Codeply-Craft", "/kaggle/working/codeply"], check=True)
os.chdir("/kaggle/working/codeply/research/dtw")
subprocess.run("pip -q install 'transformers>=4.48' peft accelerate sentencepiece pyyaml", shell=True, check=True)
subprocess.run("cd data/real && for f in *.gz; do gunzip -kf $f; done", shell=True, check=True)
split = json.load(open("data/real/SPLIT.json"))
assert split["leakChecksPass"], "leak checks failed: do not train"
for k in ("train", "val", "test"):
    assert hashlib.sha256(open(f"data/real/{k}.jsonl", "rb").read()).hexdigest() == split["hashes"][k], f"{k} changed"
print({k: v["n"] for k, v in split["splits"].items()})
!nvidia-smi --query-gpu=name,memory.total --format=csv'''

LLAMA_BUILD = r'''# llama.cpp at the pinned commit: GGUF converter and quantizer
import os, subprocess
if not os.path.exists("/kaggle/working/llama.cpp"):
    subprocess.run("git clone https://github.com/ggml-org/llama.cpp /kaggle/working/llama.cpp && cd /kaggle/working/llama.cpp && git checkout LLAMA_COMMIT", shell=True, check=True)
    subprocess.run("cd /kaggle/working/llama.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF > /dev/null && cmake --build build -j4 --target llama-quantize > /dev/null", shell=True, check=True)
    subprocess.run("pip -q install -e /kaggle/working/llama.cpp/gguf-py", shell=True, check=True)
def export_gguf(run):
    subprocess.run(f"python /kaggle/working/llama.cpp/convert_hf_to_gguf.py {run}/backbone --outtype f16 --outfile {run}/backbone-f16.gguf", shell=True, check=True)
    for q in ("Q8_0", "Q4_0"):
        subprocess.run(f"/kaggle/working/llama.cpp/build/bin/llama-quantize {run}/backbone-f16.gguf {run}/backbone-{q.lower()}.gguf {q}", shell=True, check=True)
    subprocess.run(f"python model/export_heads.py {run}", shell=True, check=True)'''.replace("LLAMA_COMMIT", LLAMA)


def nb(title, intro, cells):
    def cell(src, kind="code"):
        c = {"cell_type": kind, "metadata": {}, "source": src.strip("\n").splitlines(keepends=True)}
        if kind == "code":
            c.update({"execution_count": None, "outputs": []})
        return c
    return {"cells": [cell(f"# {title}\n\n{intro}", "markdown")] + [cell(c) for c in cells],
            "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                         "language_info": {"name": "python"}, "kaggle": {"accelerator": "gpu", "isInternetEnabled": True}},
            "nbformat": 4, "nbformat_minor": 5}


ENCODERS = nb(
    "Model selection: Ettin + Decide heads on the realistic data",
    "Ettin-150M (seeds 1-3) and Ettin-400M (seed 1) with the Decide heads, trained on the frozen train split, model "
    "selection on the validation split only. Exports GGUF Q8_0 / Q4_0 + heads.",
    [SETUP, LLAMA_BUILD, r'''
import subprocess
RUNS = [("ettin150", "jhu-clsp/ettin-encoder-150m", 1), ("ettin150", "jhu-clsp/ettin-encoder-150m", 2),
        ("ettin150", "jhu-clsp/ettin-encoder-150m", 3), ("ettin400", "jhu-clsp/ettin-encoder-400m", 1)]
for name, hf, seed in RUNS:
    run = f"runs/real-{name}-s{seed}"
    if os.path.exists(f"{run}/heads.json"):
        continue
    # Effective batch 32 as pre-registered: 8 x 4 accumulation + gradient checkpointing. The first run (bs 32)
    # ran out of memory on the T4 (16 GB): realistic inputs reach 1,462 tokens and T4 has no FlashAttention.
    subprocess.run(f"cd model && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python train_encoder.py --model {hf} "
                   f"--train ../data/real/train.spans.jsonl --val ../data/real/val.spans.jsonl "
                   f"--out ../{run} --epochs 3 --bs 8 --accum 4 --grad-ckpt --seed {seed}", shell=True, check=True)
    export_gguf(run)
''', r'''
import json, glob
for c in sorted(glob.glob("runs/*/config.json")):
    print(c.split("/")[1], json.load(open(c)).get("val"))
''', r'''
!cd runs && zip -qr /kaggle/working/real-encoders.zip . -x "*/backbone/*" "*/backbone-f16.gguf"
!ls -la /kaggle/working/real-encoders.zip
'''])

LFM3 = nb(
    "Model selection: LFM3-1.7B LoRA on the realistic data",
    "The production fine-tuning script (`ml/finetune/train_lora.py`, `config-lfm3.yaml`) on the same frozen train "
    "split, rendered with the production prompt (v2, full style, as in the evaluation). One run per seed in SEEDS; "
    "each exported to GGUF. LFM Open License v1.0.",
    [SETUP, LLAMA_BUILD, r'''
import subprocess, os, yaml
SEEDS = [1, 2]   # set per kernel; the protocol asks for 3 seeds in total
os.chdir("/kaggle/working/codeply")
subprocess.run("pip -q install -r ml/finetune/requirements.txt", shell=True, check=True)
# Kaggle's image ships torchao 0.10; PEFT refuses any torchao below 0.16 (the first run failed on it). LoRA does not use it.
subprocess.run("pip -q uninstall -y torchao", shell=True, check=True)
subprocess.run("node --version || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs) > /dev/null", shell=True, check=True)
subprocess.run("cp research/dtw/data/real/train.jsonl research/dtw/data/real/val.jsonl /tmp/ && node ml/data/export-sft.mjs --in /tmp --style full", shell=True, check=True)
for seed in SEEDS:
    cfg = yaml.safe_load(open("ml/finetune/config-lfm3.yaml"))
    # Same effective batch as config-lfm3.yaml (16), micro-batch 1 for the T4's 16 GB: with batch 4 the
    # backward pass ran out of memory on the 128K-vocabulary logits (run 2).
    cfg["grad_accum"] = cfg["grad_accum"] * cfg["batch_size"]
    cfg["batch_size"] = 1
    cfg.update({"train_file": "/tmp/sft-train.jsonl", "val_file": "/tmp/sft-val.jsonl", "seed": seed,
                "output_dir": f"ml/finetune/runs/real-lfm3-lora-s{seed}"})
    yaml.safe_dump(cfg, open(f"/tmp/config-s{seed}.yaml", "w"))
    if not os.path.exists(f"ml/finetune/runs/real-lfm3-lora-s{seed}/merged"):
        subprocess.run(f"PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python ml/finetune/train_lora.py --config /tmp/config-s{seed}.yaml", shell=True, check=True)
''', r'''
!cd /kaggle/working/llama.cpp && cmake --build build -j4 --target llama-imatrix > /dev/null
import subprocess
for seed in SEEDS:
    subprocess.run(f"cd /kaggle/working/codeply && LLAMA_CPP=/kaggle/working/llama.cpp bash ml/finetune/export_gguf.sh ml/finetune/runs/real-lfm3-lora-s{seed}/merged real-lfm3-lora-s{seed}", shell=True, check=True)
''', r'''
!cd /kaggle/working/codeply/ml/finetune/runs && zip -qr /kaggle/working/real-lfm3-lora.zip . -i "*.gguf" "*train-log.jsonl"
!ls -la /kaggle/working/real-lfm3-lora.zip
'''])

for fn, n in (("real-encoders.ipynb", ENCODERS), ("real-lfm3-lora.ipynb", LFM3)):
    json.dump(n, open(os.path.join(HERE, fn), "w"), indent=1)
    print("wrote", fn)
