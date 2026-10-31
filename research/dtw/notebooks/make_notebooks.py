"""Write the Kaggle notebooks for the Decide-then-Write GPU runs.

  python3 research/dtw/notebooks/make_notebooks.py

Each notebook clones this branch (a Kaggle secret GITHUB_TOKEN is needed if
the repository is private), installs what it needs, trains, exports GGUF
(Q8_0 and Q4_0 through llama.cpp at the pinned commit) and zips the results
into /kaggle/working for download. Settings: GPU T4 x2 or P100, Internet on.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LLAMA = "aa588a3463357ee990b314f41dda242869130704"

SETUP = r'''# Setup: clone the experiment branch and install dependencies
import os, subprocess
REPO = "github.com/AwaisSDev/Codeply-Craft"
BRANCH = "codeply-li-dtw-experiment"
try:
    from kaggle_secrets import UserSecretsClient
    token = UserSecretsClient().get_secret("GITHUB_TOKEN")
    url = f"https://{token}@{REPO}"
except Exception:
    url = f"https://{REPO}"
if not os.path.exists("/kaggle/working/codeply"):
    subprocess.run(["git", "clone", "--depth", "1", "-b", BRANCH, url, "/kaggle/working/codeply"], check=True)
os.chdir("/kaggle/working/codeply/research/dtw")
subprocess.run("pip -q install 'transformers>=4.48' peft accelerate sentencepiece", shell=True, check=True)
subprocess.run("cd data/out && for f in *.gz; do gunzip -kf $f; done", shell=True, check=True)
!nvidia-smi --query-gpu=name,memory.total --format=csv'''

LLAMA_BUILD = r'''# llama.cpp at the pinned commit: GGUF converter and quantizer
import os, subprocess
if not os.path.exists("/kaggle/working/llama.cpp"):
    subprocess.run("git clone https://github.com/ggml-org/llama.cpp /kaggle/working/llama.cpp && cd /kaggle/working/llama.cpp && git checkout LLAMA_COMMIT", shell=True, check=True)
    subprocess.run("cd /kaggle/working/llama.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF > /dev/null && cmake --build build -j4 --target llama-quantize > /dev/null", shell=True, check=True)
    subprocess.run("pip -q install -e /kaggle/working/llama.cpp/gguf-py", shell=True, check=True)

def export_gguf(run):
    """backbone -> F16 GGUF -> Q8_0 and Q4_0; heads -> heads.bin/json."""
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
    return {
        "cells": [cell(f"# {title}\n\n{intro}", "markdown")] + [cell(c) for c in cells],
        "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                     "language_info": {"name": "python"}, "kaggle": {"accelerator": "gpu", "isInternetEnabled": True}},
        "nbformat": 4, "nbformat_minor": 5,
    }


ENCODERS = nb(
    "Decide-then-Write: encoder Decide models",
    "Fine-tunes Ettin-150M, Ettin-400M and mmBERT-base with the Decide heads on the full generated training set "
    "(8000 examples, spans from `data/align.py`), three seeds each, then exports each run as GGUF (Q8_0, Q4_0) "
    "plus heads for the Node provider (`runtime/dtw-provider.mjs`). About 10-25 minutes per run on a T4.",
    [SETUP, LLAMA_BUILD, r'''
import subprocess
MODELS = {"ettin150": "jhu-clsp/ettin-encoder-150m", "ettin400": "jhu-clsp/ettin-encoder-400m", "mmbert": "jhu-clsp/mmBERT-base"}
SEEDS = [1, 2, 3]
for name, hf in MODELS.items():
    for seed in SEEDS:
        run = f"runs/{name}-s{seed}"
        if os.path.exists(f"{run}/config.json"):
            continue
        subprocess.run(f"python model/train_encoder.py --model {hf} --train data/out/train.spans.jsonl --val data/out/val.spans.jsonl "
                       f"--out {run} --epochs 3 --bs 32 --seed {seed} --val-limit 800", shell=True, check=True)
        export_gguf(run)
''', r'''
# Validation scores of every run
import json, glob
for c in sorted(glob.glob("runs/*/config.json")):
    print(c.split("/")[1], json.load(open(c))["val"])
''', r'''
!cd runs && zip -qr /kaggle/working/dtw-encoders.zip . -x "*/backbone/*" "*/backbone-f16.gguf"
!ls -la /kaggle/working/dtw-encoders.zip
'''])

LFM3_HEADS = nb(
    "Decide-then-Write: LFM3 + attached classifiers",
    "The same Decide heads on LFM3-1.7B (LiquidAI/LFM3-1.7B, `trust_remote_code`), two variants: heads only on the "
    "frozen model, and LoRA (r=16 on attention, short-conv and MLP projections) + heads. Exports the merged backbone as "
    "GGUF Q4_0 for llama.cpp (`--embedding --pooling none`) and the heads. LFM Open License v1.0.",
    [SETUP, LLAMA_BUILD, r'''
import subprocess
COMMON = ("--model LiquidAI/LFM3-1.7B --causal --trust-remote-code --train data/out/train.spans.jsonl "
          "--val data/out/val.spans.jsonl --epochs 2 --bs 8 --val-limit 400")
for name, extra in {"lfm3-heads-frozen": "--freeze-backbone --head-lr 1e-3",
                    "lfm3-heads-lora": "--lora 16 --lr 2e-4 --head-lr 1e-3"}.items():
    for seed in [1, 2, 3]:
        run = f"runs/{name}-s{seed}"
        if os.path.exists(f"{run}/config.json"):
            continue
        subprocess.run(f"python model/train_encoder.py {COMMON} {extra} --seed {seed} --out {run}", shell=True, check=True)
        export_gguf(run)
''', r'''
import json, glob
for c in sorted(glob.glob("runs/*/config.json")):
    print(c.split("/")[1], json.load(open(c))["val"])
''', r'''
!cd runs && zip -qr /kaggle/working/dtw-lfm3-heads.zip . -x "*/backbone/*" "*/adapter/*" "*/backbone-f16.gguf"
!ls -la /kaggle/working/dtw-lfm3-heads.zip
'''])

LFM3_LORA = nb(
    "Baseline: standard LFM3 LoRA fine-tune (JSON output)",
    "The control for Decide-then-Write: LFM3-1.7B fine-tuned the normal way, generating the full JSON answer, with "
    "`ml/finetune/train_lora.py` and `ml/finetune/config-lfm3.yaml` on the same 8000 generated examples rendered with "
    "the production prompt (v2, compact). Exports Q4_K_M / Q8_0 GGUF with `ml/finetune/export_gguf.sh`.",
    [SETUP, LLAMA_BUILD, r'''
import subprocess, os
os.chdir("/kaggle/working/codeply")
subprocess.run("pip -q install -r ml/finetune/requirements.txt", shell=True, check=True)
subprocess.run("cp research/dtw/data/out/sft-train.jsonl research/dtw/data/out/sft-val.jsonl ml/data/out/", shell=True, check=True)
subprocess.run("python ml/finetune/train_lora.py --config ml/finetune/config-lfm3.yaml", shell=True, check=True)
''', r'''
!cd /kaggle/working/llama.cpp && cmake --build build -j4 --target llama-imatrix > /dev/null
!cd /kaggle/working/codeply && LLAMA_CPP=/kaggle/working/llama.cpp bash ml/finetune/export_gguf.sh ml/finetune/runs/codeply-context-v1-lfm3/merged codeply-context-v1-lfm3
!cd /kaggle/working/codeply/ml/finetune/runs && zip -qr /kaggle/working/lfm3-lora-baseline.zip . -i "*.gguf" "*train-log.jsonl"
!ls -la /kaggle/working/lfm3-lora-baseline.zip
'''])

for fn, n in (("kaggle-encoders.ipynb", ENCODERS), ("kaggle-lfm3-heads.ipynb", LFM3_HEADS), ("kaggle-lfm3-lora-baseline.ipynb", LFM3_LORA)):
    json.dump(n, open(os.path.join(HERE, fn), "w"), indent=1)
    print("wrote", fn)
