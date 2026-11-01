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
if not os.path.exists("/tmp/codeply"):
    subprocess.run(["git", "clone", "--depth", "1", "-b", "codeply-li-dtw-experiment",
                    "https://github.com/AwaisSDev/Codeply-Craft", "/tmp/codeply"], check=True)
os.chdir("/tmp/codeply/research/dtw")  # outside /kaggle/working: the output keeps only artifacts
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
if not os.path.exists("/tmp/llama.cpp"):
    subprocess.run("git clone https://github.com/ggml-org/llama.cpp /tmp/llama.cpp && cd /tmp/llama.cpp && git checkout LLAMA_COMMIT", shell=True, check=True)
    subprocess.run("cd /tmp/llama.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF > /dev/null && cmake --build build -j4 --target llama-quantize > /dev/null", shell=True, check=True)
    subprocess.run("pip -q install -e /tmp/llama.cpp/gguf-py", shell=True, check=True)
def export_gguf(run):
    subprocess.run(f"python /tmp/llama.cpp/convert_hf_to_gguf.py {run}/backbone --outtype f16 --outfile {run}/backbone-f16.gguf", shell=True, check=True)
    for q in ("Q8_0", "Q4_0"):
        subprocess.run(f"/tmp/llama.cpp/build/bin/llama-quantize {run}/backbone-f16.gguf {run}/backbone-{q.lower()}.gguf {q}", shell=True, check=True)
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
import shutil
# (name, model, seed, micro-batch, accumulation): effective batch 32 for every run. Ettin-400M needs micro-batch 2 on a
# T4 (micro-batch 8 ran out of memory in run 3, after the three 150M seeds had finished).
RUNS = [("ettin150", "jhu-clsp/ettin-encoder-150m", 1, 8, 4), ("ettin150", "jhu-clsp/ettin-encoder-150m", 2, 8, 4),
        ("ettin150", "jhu-clsp/ettin-encoder-150m", 3, 8, 4), ("ettin400", "jhu-clsp/ettin-encoder-400m", 1, 2, 16),
        # Run 5: Ettin-400M seeds 2 and 3, so that the 400M lead can be judged on three seeds as the protocol requires.
        ("ettin400", "jhu-clsp/ettin-encoder-400m", 2, 2, 16), ("ettin400", "jhu-clsp/ettin-encoder-400m", 3, 2, 16)]
ONLY = os.environ.get("ONLY_RUNS", "")  # e.g. "real-ettin400-s1" to rerun only that one
for name, hf, seed, bs, accum in RUNS:
    run = f"runs/real-{name}-s{seed}"
    if os.path.exists(f"{run}/heads.json") or (ONLY and run.split("/")[1] not in ONLY.split(",")):
        continue
    # Effective batch 32 as pre-registered: 8 x 4 accumulation + gradient checkpointing. The first run (bs 32)
    # ran out of memory on the T4 (16 GB): realistic inputs reach 1,462 tokens and T4 has no FlashAttention.
    subprocess.run(f"cd model && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python train_encoder.py --model {hf} "
                   f"--train ../data/real/train.spans.jsonl --val ../data/real/val.spans.jsonl "
                   f"--out ../{run} --epochs 3 --bs {bs} --accum {accum} --grad-ckpt --seed {seed}", shell=True, check=True)
    export_gguf(run)
    # Save this run's artifacts at once, so a later failure cannot lose them.
    out = f"/kaggle/working/runs/{run.split('/')[1]}"
    os.makedirs(out, exist_ok=True)
    for f in ("heads.bin", "heads.json", "config.json", "train-log.jsonl", "backbone-q8_0.gguf", "backbone-q4_0.gguf"):
        if os.path.exists(f"{run}/{f}"):
            shutil.copy(f"{run}/{f}", out)
''', r'''
import json, glob
for c in sorted(glob.glob("runs/*/config.json")):
    print(c.split("/")[1], json.load(open(c)).get("val"))
''', r'''
!cd /kaggle/working/runs && zip -qr /kaggle/working/real-encoders.zip .
!ls -la /kaggle/working/real-encoders.zip
'''])

LFM3 = nb(
    "Model selection: LFM3-1.7B LoRA on the realistic data",
    "The production fine-tuning script (`ml/finetune/train_lora.py`, `config-lfm3.yaml`) on the same frozen train "
    "split, rendered with the production prompt (v2, full style, as in the evaluation). One run per seed in SEEDS; "
    "each exported to GGUF. LFM Open License v1.0.",
    [SETUP, LLAMA_BUILD, r'''
import subprocess, os, yaml, time
SEEDS = [1, 2]   # one per T4 (the kernel has two); the protocol asks for 3 seeds in total
W = "/kaggle/working/lora"   # under /kaggle/working so that a run stopped by the 12 h limit keeps its checkpoints
os.chdir("/tmp/codeply")
subprocess.run("pip -q install -r ml/finetune/requirements.txt", shell=True, check=True)
# Kaggle's image ships torchao 0.10; PEFT refuses any torchao below 0.16 (the first run failed on it). LoRA does not use it.
subprocess.run("pip -q uninstall -y torchao", shell=True, check=True)
subprocess.run("node --version || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs) > /dev/null", shell=True, check=True)
subprocess.run("cp research/dtw/data/real/train.jsonl research/dtw/data/real/val.jsonl /tmp/ && node ml/data/export-sft.mjs --in /tmp --style full", shell=True, check=True)
# export_gguf.sh calibrates the INT4 importance matrix on ml/data/out/sft-val.jsonl: give it the realistic val prompts.
subprocess.run("cp /tmp/sft-val.jsonl ml/data/out/sft-val.jsonl", shell=True, check=True)
procs = {}
for gpu, seed in enumerate(SEEDS):
    cfg = yaml.safe_load(open("ml/finetune/config-lfm3.yaml"))
    # Same effective batch as config-lfm3.yaml (16), micro-batch 1 for the T4's 16 GB: with batch 4 the
    # backward pass ran out of memory on the 128K-vocabulary logits (run 2).
    cfg["grad_accum"] = cfg["grad_accum"] * cfg["batch_size"]
    cfg["batch_size"] = 1
    out = f"{W}/real-lfm3-lora-s{seed}"
    cfg.update({"train_file": "/tmp/sft-train.jsonl", "val_file": "/tmp/sft-val.jsonl", "seed": seed, "output_dir": out})
    os.makedirs(out, exist_ok=True)
    yaml.safe_dump(cfg, open(f"/tmp/config-s{seed}.yaml", "w"))
    if not os.path.exists(f"{out}/merged"):
        # Both seeds at once, one GPU each (run 3 used one of the two T4s and needed ~17.6 h per seed).
        procs[seed] = subprocess.Popen(f"CUDA_VISIBLE_DEVICES={gpu} PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True "
                                       f"python ml/finetune/train_lora.py --config /tmp/config-s{seed}.yaml > {out}/stdout.log 2>&1", shell=True)
while any(p.poll() is None for p in procs.values()):
    time.sleep(600)
    for seed in procs:
        print(seed, open(f"{W}/real-lfm3-lora-s{seed}/stdout.log").read().strip().splitlines()[-1][:200], flush=True)
for seed, p in procs.items():
    print(f"seed {seed} exit {p.returncode}:", open(f"{W}/real-lfm3-lora-s{seed}/stdout.log").read()[-3000:], flush=True)
''', r'''
!cd /tmp/llama.cpp && cmake --build build -j4 --target llama-imatrix > /dev/null
import subprocess, shutil, glob, os
for seed in SEEDS:
    out = f"{W}/real-lfm3-lora-s{seed}"
    if not os.path.exists(f"{out}/merged"):
        print(f"seed {seed}: no merged model (training did not finish); adapters:", glob.glob(f"{out}/adapter*")); continue
    # f16 GGUF and imatrix in /tmp (not kept); the two quantised models go to the output; the merged weights are
    # deleted once exported (the adapter, ~130 MB, stays and can be merged again).
    subprocess.run(f"cd /tmp/codeply && OUT=/tmp/gguf-s{seed} LLAMA_CPP=/tmp/llama.cpp bash ml/finetune/export_gguf.sh {out}/merged real-lfm3-lora-s{seed}", shell=True, check=True)
    for f in glob.glob(f"/tmp/gguf-s{seed}/*Q4_K_M.gguf") + glob.glob(f"/tmp/gguf-s{seed}/*Q8_0.gguf"):
        shutil.copy(f, out)
    shutil.rmtree(f"{out}/merged")
    shutil.rmtree(f"/tmp/gguf-s{seed}")
''', r'''
!ls -laR /kaggle/working/lora | grep -v "^total"
'''])

LFM3_EXPORT = nb(
    "Model selection: GGUF export of the LFM3-1.7B LoRA runs",
    "Run 4 of the LoRA notebook trained both seeds (the merged models are in its output) but hit Kaggle's 12-hour "
    "limit during export: the importance-matrix calibration ran on the CPU (~3 h per seed). This notebook only "
    "exports: the same export_gguf.sh (f16, importance matrix on the realistic val prompts with 200 chunks, Q4_K_M, "
    "Q8_0), with llama.cpp built with CUDA so the calibration runs on the GPU. Input: the output of "
    "codeply-real-lfm3-lora.",
    [SETUP, r"""
import os, subprocess, glob
IMATRIX_ARGS = "-ngl 99"
if not os.path.exists("/tmp/llama.cpp/build/bin/llama-imatrix"):
    subprocess.run("git clone https://github.com/ggml-org/llama.cpp /tmp/llama.cpp && cd /tmp/llama.cpp && git checkout LLAMA_COMMIT", shell=True, check=True)
    # Export v2 failed here: ggml-cuda links CUDA::cuda_driver, which Kaggle's image does not expose to CMake.
    # That link exists only for CUDA virtual memory management (GGML_CUDA_NO_VMM=ON drops it); the driver stub
    # directory is given as well. If the CUDA build still fails, fall back to the CPU build (~3 h per seed).
    has_gpu = subprocess.run("nvidia-smi", shell=True, capture_output=True).returncode == 0
    print("GPU:", has_gpu)
    # No GPU (e.g. a CPU session once the weekly GPU quota is used up): skip the CUDA build entirely.
    cuda = subprocess.run("false" if not has_gpu else "cd /tmp/llama.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF "
                          "-DLLAMA_BUILD_EXAMPLES=OFF -DGGML_CUDA=ON -DGGML_CUDA_NO_VMM=ON -DCMAKE_CUDA_ARCHITECTURES=75 "
                          "-DCMAKE_LIBRARY_PATH=/usr/local/cuda/lib64/stubs && "
                          "cmake --build build -j4 --target llama-quantize llama-imatrix", shell=True, capture_output=True, text=True)
    if cuda.returncode:
        print("CUDA build failed, building for CPU:", cuda.stdout[-1500:], cuda.stderr[-1500:])
        IMATRIX_ARGS = ""
        subprocess.run("cd /tmp/llama.cpp && rm -rf build && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF "
                       "-DLLAMA_BUILD_EXAMPLES=OFF > /dev/null && cmake --build build -j4 --target llama-quantize llama-imatrix > /dev/null",
                       shell=True, check=True)
print("imatrix args:", repr(IMATRIX_ARGS))
subprocess.run("pip -q install -e /tmp/llama.cpp/gguf-py", shell=True, check=True)
subprocess.run("node --version || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs) > /dev/null", shell=True, check=True)
os.chdir("/tmp/codeply")
# Calibration text = the realistic val prompts, as in run 4 (export_gguf.sh reads ml/data/out/sft-val.jsonl).
subprocess.run("cp research/dtw/data/real/train.jsonl research/dtw/data/real/val.jsonl /tmp/ && node ml/data/export-sft.mjs --in /tmp --style full "
               "&& cp /tmp/sft-val.jsonl ml/data/out/sft-val.jsonl", shell=True, check=True)
MERGE = '''
import glob, subprocess, sys, torch, yaml
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
sys.path.insert(0, "/tmp/codeply/ml/finetune")
from train_lora import copy_base_tokenizer
base = yaml.safe_load(open("/tmp/codeply/ml/finetune/config-lfm3.yaml"))["base_model"]
for ad in sys.argv[1:]:
    name = [x for x in ad.split("/") if x.startswith("real-lfm3-lora-s")][-1]
    m = f"/tmp/merged/{name}/merged"
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.float16, trust_remote_code=True)
    model = PeftModel.from_pretrained(model, ad).merge_and_unload()
    model.save_pretrained(m, safe_serialization=True)
    AutoTokenizer.from_pretrained(base, trust_remote_code=True).save_pretrained(m)
    copy_base_tokenizer(base, m)
    subprocess.run(f"cp {ad}/../train-log.jsonl /tmp/merged/{name}/ 2>/dev/null", shell=True)
    print("merged", name, flush=True)
    del model
'''
merged = sorted(glob.glob("/kaggle/input/**/real-lfm3-lora-s*/merged", recursive=True))
if not merged:
    # Kaggle does not accept a cancelled run as a kernel source, so the adapters come in as a private dataset
    # (codeply-real-lfm3-lora-adapters: the final adapter of each seed from run 4). Merge them exactly as
    # ml/finetune/train_lora.py does: base in fp16 on the T4, PEFT merge_and_unload, base tokenizer files.
    # The merge runs in a fresh Python process: export v3 failed importing peft/transformers in the notebook's
    # own process after the pip installs above had changed numpy under it.
    # The dataset may hold one archive per seed (kaggle datasets create -r tar); unpack them if so.
    os.makedirs("/tmp/inp", exist_ok=True)
    for a in glob.glob("/kaggle/input/**/*.tar", recursive=True) + glob.glob("/kaggle/input/**/*.zip", recursive=True):
        subprocess.run(f"cd /tmp/inp && (tar -xf {a} 2>/dev/null || unzip -oq {a})", shell=True)
    adapters = sorted(set(glob.glob("/kaggle/input/**/real-lfm3-lora-s*/adapter", recursive=True) + glob.glob("/tmp/inp/**/adapter", recursive=True)))
    print("adapters:", adapters)
    assert adapters, "no adapters in the input"
    # As in the LoRA notebook (run 1): Kaggle ships torchao 0.10, which PEFT rejects when it loads LoRA layers.
    subprocess.run("pip -q uninstall -y torchao", shell=True)
    open("/tmp/merge_lora.py", "w").write(MERGE)
    if subprocess.run("python -c 'import numpy, torch, transformers, peft'", shell=True).returncode:
        subprocess.run("pip -q install --force-reinstall --no-deps numpy==$(python -c 'import importlib.metadata as m; print(m.version(\"numpy\"))')", shell=True)
    subprocess.run("python /tmp/merge_lora.py " + " ".join(adapters), shell=True, check=True)
    merged = sorted(glob.glob("/tmp/merged/real-lfm3-lora-s*/merged"))
print(merged)
assert merged, "no merged models and no adapters in the input"
for m in merged:
    name = m.split("/")[-2]
    out = f"/kaggle/working/runs/{name}"
    os.makedirs(out, exist_ok=True)
    if glob.glob(f"{out}/*Q4_K_M.gguf"):
        continue
    subprocess.run(f"cd /tmp/codeply && OUT=/tmp/gguf-{name} IMATRIX_ARGS='{IMATRIX_ARGS}' LLAMA_CPP=/tmp/llama.cpp "
                   f"bash ml/finetune/export_gguf.sh {m} {name}", shell=True, check=True)
    for f in glob.glob(f"/tmp/gguf-{name}/*Q4_K_M.gguf") + glob.glob(f"/tmp/gguf-{name}/*Q8_0.gguf") + glob.glob(f"{m}/../train-log.jsonl"):
        subprocess.run(f"cp {f} {out}/", shell=True, check=True)
    subprocess.run(f"rm -rf /tmp/gguf-{name}", shell=True, check=True)
""".replace("LLAMA_COMMIT", LLAMA), r"""
!ls -laR /kaggle/working/runs
"""])

for fn, n in (("real-encoders.ipynb", ENCODERS), ("real-lfm3-lora.ipynb", LFM3), ("real-lfm3-export.ipynb", LFM3_EXPORT)):
    json.dump(n, open(os.path.join(HERE, fn), "w"), indent=1)
    print("wrote", fn)
