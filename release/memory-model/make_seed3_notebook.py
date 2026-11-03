"""Kaggle notebook for the memory model release: in one free GPU session (T4),
  1. export seeds 1 and 2 through the production path (release/memory-model/export_local.sh: merge as
     train_lora.py, then the commands of export_gguf.sh) with llama.cpp built with CUDA, so the importance matrix
     takes minutes instead of hours;
  2. train seed 3 with the production fine-tuning script and the exact run-4 configuration (fp16 on the T4,
     micro-batch 1 x accumulation 16, the frozen realistic train split, full-style prompt);
  3. export seed 3 the same way.
Every finished file is written under /kaggle/working at once (a 12 h stop keeps what is done).
Inputs: the private datasets awaissididique/codeply-real-lfm3-lora-adapters (seeds 1, 2 final adapters) and
awaissididique/codeply-memory-derived-data (the WildChat-derived split, kept out of the public repository).

  python3 release/memory-model/make_seed3_notebook.py   ->  release/memory-model/kaggle-memory-model.ipynb
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LLAMA = "aa588a3463357ee990b314f41dda242869130704"

SETUP = r'''# Setup: the release branch (public), dependencies, the frozen split
import os, subprocess, hashlib, json
if not os.path.exists("/tmp/codeply"):
    subprocess.run(["git", "clone", "--depth", "1", "-b", "codeply-memory-model",
                    "https://github.com/AwaisSDev/Codeply-Craft", "/tmp/codeply"], check=True)
os.chdir("/tmp/codeply")
# The derived data is not in the public repository (PRIVATE-DATA.md): restore it from the attached private dataset.
import glob
src = [os.path.dirname(d) for d in glob.glob("/kaggle/input/**/derived-data", recursive=True)]
assert src, "attach the private dataset awaissididique/codeply-memory-derived-data"
subprocess.run(f"PRIVATE_DATA_DIR={src[0]} release/memory-model/fetch-private-data.sh", shell=True, check=True)
subprocess.run("cd research/dtw/data/real && for f in *.gz; do gunzip -kf $f; done", shell=True, check=True)
split = json.load(open("research/dtw/data/real/SPLIT.json"))
assert split["leakChecksPass"], "leak checks failed: do not train"
for k in ("train", "val", "test"):
    assert hashlib.sha256(open(f"research/dtw/data/real/{k}.jsonl", "rb").read()).hexdigest() == split["hashes"][k], f"{k} changed"
print({k: v["n"] for k, v in split["splits"].items()})
!nvidia-smi --query-gpu=name,memory.total --format=csv'''

TOOLS = r'''# llama.cpp at the pinned commit with CUDA (GGML_CUDA_NO_VMM: Kaggle's image does not expose CUDA::cuda_driver);
# the training run's library versions (ml/finetune/requirements.txt); no torchao (PEFT rejects Kaggle's 0.10).
import os, subprocess, glob
IMATRIX_ARGS = "-ngl 99"
if not os.path.exists("/tmp/llama.cpp/build/bin/llama-imatrix"):
    subprocess.run("git clone https://github.com/ggml-org/llama.cpp /tmp/llama.cpp && cd /tmp/llama.cpp && git checkout LLAMA_COMMIT", shell=True, check=True)
    cuda = subprocess.run("cd /tmp/llama.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF "
                          "-DLLAMA_BUILD_EXAMPLES=OFF -DGGML_CUDA=ON -DGGML_CUDA_NO_VMM=ON -DCMAKE_CUDA_ARCHITECTURES=75 "
                          "-DCMAKE_LIBRARY_PATH=/usr/local/cuda/lib64/stubs && cmake --build build -j4 --target llama-quantize llama-imatrix",
                          shell=True, capture_output=True, text=True)
    if cuda.returncode:
        print("CUDA build failed, building for CPU:", cuda.stderr[-1500:])
        IMATRIX_ARGS = ""
        subprocess.run("cd /tmp/llama.cpp && rm -rf build && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF "
                       "-DLLAMA_BUILD_EXAMPLES=OFF > /dev/null && cmake --build build -j4 --target llama-quantize llama-imatrix > /dev/null", shell=True, check=True)
print("imatrix args:", repr(IMATRIX_ARGS))
subprocess.run("pip -q install -e /tmp/llama.cpp/gguf-py && pip -q install -r ml/finetune/requirements.txt && pip -q install sentencepiece", shell=True, check=True)
subprocess.run("pip -q uninstall -y torchao", shell=True)
subprocess.run("node --version || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs) > /dev/null", shell=True, check=True)
os.makedirs("/tmp/inp", exist_ok=True)
for a in glob.glob("/kaggle/input/**/*.tar", recursive=True):
    subprocess.run(f"cd /tmp/inp && tar -xf {a}", shell=True)
ADAPTERS = {s: (glob.glob(f"/kaggle/input/**/real-lfm3-lora-s{s}/adapter", recursive=True) + glob.glob(f"/tmp/inp/**/real-lfm3-lora-s{s}/adapter", recursive=True))[0]
            for s in (1, 2)}
print(ADAPTERS)

def export(seed, adapter):
    # Fresh processes (bash, python): pip above changed packages under this notebook's own process.
    env = f"W=/kaggle/working/release LLAMA_SRC=/tmp/llama.cpp PY=python IMATRIX_ARGS='{IMATRIX_ARGS}'"
    r = subprocess.run(f"cd /tmp/codeply && {env} bash release/memory-model/export_local.sh {seed} {adapter}", shell=True)
    print(f"seed {seed} export exit {r.returncode}", flush=True)
'''.replace("LLAMA_COMMIT", LLAMA)

EXPORT_12 = r'''# 1. Production export of seeds 1 and 2 (minutes each with the GPU importance matrix)
for s in (1, 2):
    export(s, ADAPTERS[s])
!ls -la /kaggle/working/release/export/*/
'''

TRAIN_3 = r'''# 2. Seed 3: the production fine-tuning script, the exact run-4 configuration
import yaml, subprocess, os
subprocess.run("cp research/dtw/data/real/train.jsonl research/dtw/data/real/val.jsonl /tmp/ && node ml/data/export-sft.mjs --in /tmp --style full", shell=True, check=True)
cfg = yaml.safe_load(open("ml/finetune/config-lfm3.yaml"))
cfg["grad_accum"] = cfg["grad_accum"] * cfg["batch_size"]   # effective batch 16, as in config-lfm3.yaml
cfg["batch_size"] = 1                                         # micro-batch 1 on the T4 (128K-vocabulary logits)
OUT3 = "/kaggle/working/lora/real-lfm3-lora-s3"
cfg.update({"train_file": "/tmp/sft-train.jsonl", "val_file": "/tmp/sft-val.jsonl", "seed": 3, "output_dir": OUT3})
os.makedirs(OUT3, exist_ok=True)
yaml.safe_dump(cfg, open("/tmp/config-s3.yaml", "w"))
if not os.path.exists(f"{OUT3}/adapter/adapter_model.safetensors"):
    r = subprocess.run(f"CUDA_VISIBLE_DEVICES=0 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python ml/finetune/train_lora.py "
                       f"--config /tmp/config-s3.yaml > {OUT3}/stdout.log 2>&1", shell=True)
    print("seed 3 exit", r.returncode)
print(open(f"{OUT3}/stdout.log").read()[-2500:])
subprocess.run(f"rm -rf {OUT3}/merged", shell=True)   # re-merged from the adapter by the export, as for seeds 1, 2
'''

EXPORT_3 = r'''# 3. Production export of seed 3
export(3, OUT3 + "/adapter")
!ls -laR /kaggle/working/release /kaggle/working/lora | grep -v "^total"
!cat /kaggle/working/release/export/*/SHA256SUMS
'''


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


NB = nb("Memory model release: production export of seeds 1-2, training and export of seed 3",
        "See release/memory-model/PROGRESS.md. Settings: GPU T4, Internet on, private datasets "
        "awaissididique/codeply-real-lfm3-lora-adapters and awaissididique/codeply-memory-derived-data attached. LFM Open License v1.0 (base model).",
        [SETUP, TOOLS, EXPORT_12, TRAIN_3, EXPORT_3])
json.dump(NB, open(os.path.join(HERE, "kaggle-memory-model.ipynb"), "w"), indent=1)
print("wrote kaggle-memory-model.ipynb")
