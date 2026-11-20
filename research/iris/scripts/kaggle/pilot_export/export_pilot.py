"""P2: export the seed-1 pilot adapters to GGUF Q4_K_M on a CPU-only Kaggle kernel (no GPU quota).

Inputs: codeply-iris-pilot-src (configs) and the output of codeply-iris-pilot-train (adapters, best checkpoint by val
loss). Per model: base (fp32 on CPU) + LoRA -> merge_and_unload -> save fp16 with the base tokenizer (its chat template is
the one embedded in the GGUF) -> llama.cpp 7a4117e convert_hf_to_gguf.py (f16) -> llama-quantize Q4_K_M. The text model
only (no mmproj). Outputs /kaggle/working/gguf/<m>-pilot-s1-Q4_K_M.gguf and SHA256SUMS; intermediates live in /tmp.
"""
import glob, hashlib, json, os, shutil, subprocess, sys, time
T0 = time.time()
W = "/kaggle/working"
COMMIT = "7a4117eef97ed6419241da2384b2b1c011ecd763"
PINS = "transformers==5.23.0 peft==0.22.0 accelerate==1.16.0"
def sh(cmd, check=True):
    print(f"[{time.time()-T0:6.0f}s] + {cmd[:220]}", flush=True)
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode and check:
        print(r.stdout[-3000:], r.stderr[-3000:], flush=True)
        raise SystemExit(f"failed: {cmd[:160]}")
    return r
sh(f"{sys.executable} -m pip install -q {PINS} sentencepiece protobuf")
init = sorted(glob.glob("/kaggle/input/**/codeply_iris/__init__.py", recursive=True))
if not init:
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    init = sorted(glob.glob(f"{W}/src/**/codeply_iris/__init__.py", recursive=True))
SRC = os.path.dirname(os.path.dirname(init[0]))
L = "/tmp/llama"
sh(f"rm -rf {L} && mkdir {L} && cd {L} && git init -q && git remote add origin https://github.com/ggml-org/llama.cpp.git && "
   f"git fetch -q --depth 1 origin {COMMIT} && git checkout -q FETCH_HEAD")
sh(f"{sys.executable} -m pip install -q {L}/gguf-py")
sh(f"cd {L} && cmake -S . -B build -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release > /tmp/cmake.log 2>&1 && "
   f"cmake --build build -j{os.cpu_count()} --target llama-quantize > /tmp/build.log 2>&1")
os.makedirs(f"{W}/gguf", exist_ok=True)
MERGE = r'''
# Streaming LoRA merge: one safetensors shard at a time; W' = W + (alpha / r) * B @ A computed in fp32, saved in fp16
# (the precision of the frozen weights during training). Every adapter module must be found exactly once.
import glob, json, os, shutil, sys, torch
from huggingface_hub import snapshot_download
from safetensors import safe_open
from safetensors.torch import save_file
cfg, adapter, out = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
base = snapshot_download(cfg["base"], allow_patterns=["*.json", "*.safetensors", "*.model", "*.jinja", "*.txt"])
acfg = json.load(open(f"{adapter}/adapter_config.json"))
scale = acfg["lora_alpha"] / acfg["r"]
lora = {}
with safe_open(f"{adapter}/adapter_model.safetensors", "pt") as f:
    for k in f.keys():
        mod, ab = k.rsplit(".lora_", 1)
        mod = mod[len("base_model.model."):] if mod.startswith("base_model.model.") else mod
        lora.setdefault(mod, {})[ab.split(".")[0]] = f.get_tensor(k).float()
os.makedirs(out, exist_ok=True)
merged = set()
for shard in sorted(glob.glob(f"{base}/*.safetensors")):
    tensors = {}
    with safe_open(shard, "pt") as f:
        for k in f.keys():
            t = f.get_tensor(k)
            mod = k[:-len(".weight")] if k.endswith(".weight") else None
            if mod in lora:
                t = (t.float() + scale * (lora[mod]["B"] @ lora[mod]["A"])).to(torch.float16)
                merged.add(mod)
            elif t.is_floating_point():
                t = t.to(torch.float16)
            tensors[k] = t.contiguous()
    save_file(tensors, f"{out}/{os.path.basename(shard)}", metadata={"format": "pt"})
missing = set(lora) - merged
assert not missing, f"adapter modules not found in the base: {sorted(missing)[:5]}"
for f in glob.glob(f"{base}/*"):
    if not f.endswith(".safetensors") and os.path.isfile(f):
        shutil.copy(f, out)
c = json.load(open(f"{out}/config.json"))
c["torch_dtype"] = c["dtype"] = "float16"
json.dump(c, open(f"{out}/config.json", "w"), indent=2)
print("merged", len(merged), "modules into", out)
'''
open("/tmp/merge.py", "w").write(MERGE)
status = {}
for name in ("qwen3-1.7b", "qwen3-4b-2507", "gemma-4-e2b"):
    t = time.time()
    run = sorted(glob.glob(f"/kaggle/input/**/runs/pilot-{name}-s1", recursive=True))
    if not run or not os.path.exists(f"{run[0]}/DONE"):
        status[name] = {"error": "no finished training run"}
        continue
    adapter = f"{run[0]}/best/adapter" if os.path.exists(f"{run[0]}/best/adapter/adapter_config.json") else f"{run[0]}/final/adapter"
    merged, f16 = f"/tmp/merged-{name}", f"/tmp/{name}-f16.gguf"
    q4 = f"{W}/gguf/{name}-pilot-s1-Q4_K_M.gguf"
    env = "HF_HOME=/tmp/hf "
    sh(f"{env}{sys.executable} /tmp/merge.py {SRC}/foundation-2026-11/pilot/configs/{name}.json {adapter} {merged}")
    sh(f"{env}{sys.executable} {L}/convert_hf_to_gguf.py {merged} --outtype f16 --outfile {f16}")
    sh(f"{L}/build/bin/llama-quantize {f16} {q4} Q4_K_M")
    h = hashlib.sha256(open(q4, "rb").read()).hexdigest()
    status[name] = {"adapter": os.path.relpath(adapter, run[0]), "gguf": os.path.basename(q4), "sha256": h,
                    "GiB": round(os.path.getsize(q4) / 2**30, 2), "minutes": round((time.time() - t) / 60, 1)}
    print(name, status[name], flush=True)
    shutil.rmtree(merged, ignore_errors=True)
    os.remove(f16)
    shutil.rmtree("/tmp/hf", ignore_errors=True)
with open(f"{W}/gguf/SHA256SUMS", "w") as f:
    for n, s in status.items():
        if "sha256" in s:
            f.write(f"{s['sha256']}  {s['gguf']}\n")
json.dump({"models": status, "llama_cpp": COMMIT, "elapsed_s": round(time.time() - T0)}, open(f"{W}/export-status.json", "w"), indent=1)
