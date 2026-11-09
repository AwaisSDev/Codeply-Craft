"""Merge a trained LoRA adapter into the foundation and package standalone weights.

    python -m codeply_iris.export --base Qwen/Qwen3-0.6B --adapter runs/<run>/best/adapter --out release/iris-1 \
        [--llama-cpp /path/to/llama.cpp] [--quant Q8_0 Q4_K_M]

Writes <out>/hf (merged safetensors + tokenizer + config: loads with plain transformers, no adapter, no teacher),
<out>/iris-1-F16.gguf and one GGUF per --quant, and <out>/MANIFEST.json (sizes, sha256, provenance).
GGUF conversion uses llama.cpp's own convert_hf_to_gguf.py and llama-quantize.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", default="iris-1")
    ap.add_argument("--llama-cpp", default="")
    ap.add_argument("--quant", nargs="*", default=["Q8_0", "Q4_K_M"])
    a = ap.parse_args(argv)
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    out = Path(a.out)
    hf = out / "hf"
    hf.mkdir(parents=True, exist_ok=True)
    base = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.float32)
    model = PeftModel.from_pretrained(base, a.adapter).merge_and_unload()      # merge in fp32, store in fp16
    model = model.to(torch.float16)
    model.save_pretrained(str(hf), safe_serialization=True)
    AutoTokenizer.from_pretrained(a.base).save_pretrained(str(hf))
    files = {}
    if a.llama_cpp:
        lc = Path(a.llama_cpp)
        f16 = out / f"{a.name}-F16.gguf"
        subprocess.run([sys.executable, str(lc / "convert_hf_to_gguf.py"), str(hf), "--outfile", str(f16), "--outtype", "f16"], check=True)
        files[f16.name] = f16
        quant = next((p for p in (lc / "build" / "bin" / "llama-quantize", lc / "llama-quantize") if p.exists()), None)
        for q in a.quant:
            if quant is None:
                print("llama-quantize not found: skipping", q)
                continue
            dst = out / f"{a.name}-{q}.gguf"
            subprocess.run([str(quant), str(f16), str(dst), q], check=True)
            files[dst.name] = dst
    files["hf/model.safetensors"] = hf / "model.safetensors"
    manifest = {"name": a.name, "base": a.base, "adapter": str(a.adapter),
                "files": {k: {"bytes": p.stat().st_size, "sha256": sha256(p)} for k, p in files.items() if p.exists()}}
    (out / "MANIFEST.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
