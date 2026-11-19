#!/usr/bin/env python3
"""Verify the foundation candidates from primary sources and measure their tokenizers on real Iris prompts.

For every model id: the Hugging Face API record (creation date, licence tag, gating, parameter count from the
safetensors index, declared languages), its config.json (architecture class, model_type, layers, context), its model
card text (searched for Urdu, thinking-mode and licence terms), whether llama.cpp's converter registers the
architecture class (convert_hf_to_gguf.py on master), whether transformers ships the model_type natively, and
which GGUF repositories exist. Then the tokenizer of each model is applied to the rendered IrisBench validation
prompts (data/built/val.jsonl, observe tasks) to count prompt tokens per language.

Network reads only (huggingface.co, raw.githubusercontent.com); nothing is downloaded except config, card and
tokenizer files, cached in $IRIS_CACHE (default: a temp dir). Writes foundation-2026-11/model_verification.json.

    cd research/iris && python3 foundation-2026-11/verify_models.py
"""
import datetime as dt
import json
import os
import re
import statistics
import sys
import tempfile
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
from codeply_iris import prompt  # noqa: E402

CACHE = Path(os.environ.get("IRIS_CACHE", Path(tempfile.gettempdir()) / "iris-verify-cache"))
CACHE.mkdir(parents=True, exist_ok=True)

SHORTLIST = ["Qwen/Qwen3.5-2B", "Qwen/Qwen3.5-4B", "Qwen/Qwen3-4B-Instruct-2507", "google/gemma-4-E2B-it",
             "LiquidAI/LFM3-1.7B", "ibm-granite/granite-4.2-3b", "LiquidAI/LFM2.5-2.6B", "Qwen/Qwen3.5-0.8B",
             "Qwen/Qwen3-1.7B", "microsoft/Aion-1.0-Instruct-2.3B"]
BASELINES = ["Qwen/Qwen3-0.6B"]
RECONSIDER = ["mistralai/Ministral-3-3B-Instruct-2512", "CohereLabs/tiny-aya-global", "microsoft/Phi-4-mini-instruct",
              "google/gemma-4-E4B-it", "HuggingFaceTB/SmolLM3-3B", "LiquidAI/LFM2-1.2B-Extract",
              "tiiuae/Falcon-H1-1.5B-Deep-Instruct", "LiquidAI/LFM2.5-1.2B-Instruct", "Qwen/Qwen3-4B"]
RUNTIME = set()
UA = {"User-Agent": "iris-research-verify/1.0"}


def get(url, binary=False, cache_name=None):
    path = CACHE / (cache_name or re.sub(r"[^A-Za-z0-9._-]", "_", url))
    if path.exists():
        data = path.read_bytes()
    else:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            return None if e.code in (401, 403, 404) else (_ for _ in ()).throw(e)
        path.write_bytes(data)
    return data if binary else data.decode("utf-8", "replace")


def get_json(url):
    t = get(url)
    return json.loads(t) if t else None


def card_facts(text):
    if not text:
        return {}
    low = text.lower()
    lines = [l.strip() for l in text.splitlines()]
    def grab(pat, n=3):
        return [l[:300] for l in lines if re.search(pat, l, re.I)][:n]
    return {
        "mentions_urdu": "urdu" in low,
        "urdu_lines": grab(r"\burdu\b"),
        "language_lines": grab(r"(supported languages|languages?:|multilingual|languages and dialects)"),
        "thinking_lines": grab(r"(enable_thinking|thinking mode|non-thinking|/no_think|reasoning mode)"),
        "licence_lines": grab(r"(license|licence)", 4),
        "revenue_cap_lines": grab(r"(\$\s?10|10,000,000|annual revenue|revenue)"),
        "gguf_lines": grab(r"gguf|llama\.cpp", 4),
        "trust_remote_code": "trust_remote_code" in low,
    }


LLAMA = "https://raw.githubusercontent.com/ggml-org/llama.cpp/master"


def converter_archs():
    """HF architecture class -> converter module, from llama.cpp's conversion package (convert_hf_to_gguf.py
    imports it; the class maps live in conversion/__init__.py)."""
    src = get(f"{LLAMA}/conversion/__init__.py") or ""
    return dict(re.findall(r'^\s*"([A-Za-z0-9_]+)"\s*:\s*"([a-z0-9_]+)"', src, re.M))


def runtime_archs():
    """GGUF architecture names the llama.cpp runtime knows (src/llama-arch.cpp)."""
    src = get(f"{LLAMA}/src/llama-arch.cpp") or ""
    return set(re.findall(r'\{\s*LLM_ARCH_[A-Z0-9_]+\s*,\s*"([a-z0-9_.-]+)"\s*\}', src))


def transformers_types():
    src = get("https://raw.githubusercontent.com/huggingface/transformers/main/src/transformers/models/auto/auto_mappings.py") or ""
    return set(re.findall(r'\(\s*"([a-z0-9_]+)"\s*,\s*"[A-Za-z0-9_]+Config"\s*\)', src))


def gguf_repos(model_id):
    base = model_id.split("/")[1]
    found = {}
    for q in (base, base.replace("-it", "").replace("-Instruct", "")):
        res = get_json(f"https://huggingface.co/api/models?search={q}&filter=gguf&limit=50&sort=downloads&direction=-1") or []
        for r in res:
            found[r["id"]] = r.get("downloads", 0)
    org = model_id.split("/")[0]
    official = sorted(k for k in found if k.split("/")[0] == org)
    third = sorted(((v, k) for k, v in found.items() if k.split("/")[0] != org), reverse=True)[:5]
    return {"official": official, "top_third_party": [k for v, k in third], "n_repos_found": len(found)}


def text_config(cfg):
    if not cfg:
        return {}
    tc = cfg.get("text_config") or cfg
    return {"architectures": cfg.get("architectures"), "model_type": cfg.get("model_type"),
            "text_model_type": tc.get("model_type"), "layers": tc.get("num_hidden_layers"),
            "hidden": tc.get("hidden_size"), "vocab": tc.get("vocab_size"),
            "max_position_embeddings": tc.get("max_position_embeddings"),
            "layer_types": sorted(set(tc.get("layer_types") or [])) or None,
            "has_vision": any(k in cfg for k in ("vision_config", "audio_config")),
            "tie_word_embeddings": tc.get("tie_word_embeddings", cfg.get("tie_word_embeddings"))}


def verify(model_id, regs, ttypes):
    info = get_json(f"https://huggingface.co/api/models/{model_id}") or {}
    out = {"id": model_id, "exists": bool(info)}
    if not info:
        return out
    card = info.get("cardData") or {}
    st = info.get("safetensors") or {}
    cfg = get_json(f"https://huggingface.co/{model_id}/raw/main/config.json")
    readme = get(f"https://huggingface.co/{model_id}/raw/main/README.md")
    tc = text_config(cfg)
    arch = (tc.get("architectures") or [None])[0]
    out.update({
        "created_at": info.get("createdAt"), "last_modified": info.get("lastModified"),
        "gated": info.get("gated"), "licence_tag": card.get("license") or [t for t in info.get("tags", []) if t.startswith("license:")],
        "licence_name": card.get("license_name"), "card_languages": card.get("language"),
        "pipeline_tag": info.get("pipeline_tag"), "library": info.get("library_name"),
        "params_total_safetensors": st.get("total"), "params_by_dtype": st.get("parameters"),
        "config": tc, "config_readable": cfg is not None,
        "llama_cpp_converter_module": regs.get(arch) if arch else None,
        "llama_cpp_runtime_arch_known": (regs.get(arch) in RUNTIME or (tc.get("text_model_type") or "").replace("_", "") in RUNTIME) if arch else None,
        "transformers_native_model_type": (tc.get("model_type") in ttypes) if tc.get("model_type") else None,
        "card": card_facts(readme), "gguf": gguf_repos(model_id),
        "downloads_30d": info.get("downloads"),
    })
    return out


def tokenizer_counts(model_id):
    tj = get(f"https://huggingface.co/{model_id}/resolve/main/tokenizer.json", binary=True,
             cache_name=model_id.replace("/", "__") + "__tokenizer.json")
    if not tj:
        return None
    from tokenizers import Tokenizer
    tok = Tokenizer.from_str(tj.decode("utf-8"))
    rows = [json.loads(l) for l in (ROOT / "data" / "built" / "val.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    per_lang, inputs_only = defaultdict(list), defaultdict(list)
    for ex in rows:
        if ex["task"] != "observe":
            continue
        user = prompt.observe_prompt(ex["now"], ex["source"], ex["memories"], ex["messages"])
        full = prompt.ZERO_SHOT_SYSTEM + "\n" + user          # template tokens differ per model and are excluded
        n = len(tok.encode(full, add_special_tokens=False).ids)
        per_lang[ex["lang"]].append(n)
        per_lang["all"].append(n)
        inp = prompt.render_messages(ex["messages"])
        words = sum(len(m["text"].split()) for m in ex["messages"])
        if words:
            inputs_only[ex["lang"]].append(len(tok.encode(inp, add_special_tokens=False).ids) / words)
    return {"vocab_size": tok.get_vocab_size(),
            "zero_shot_prompt_tokens": {k: {"mean": round(statistics.mean(v)), "p95": sorted(v)[int(0.95 * (len(v) - 1))], "max": max(v), "n": len(v)}
                                        for k, v in sorted(per_lang.items())},
            "input_tokens_per_word": {k: round(statistics.mean(v), 2) for k, v in sorted(inputs_only.items())}}


def main():
    global RUNTIME
    regs, ttypes = converter_archs(), transformers_types()
    RUNTIME = runtime_archs()
    out = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "sources": {"hf_api": "https://huggingface.co/api/models/<id>", "llama_cpp": "convert_hf_to_gguf.py on master",
                       "transformers": "configuration_auto.py on main"},
           "llama_cpp_converter_classes": len(regs), "llama_cpp_runtime_archs": sorted(RUNTIME), "models": {}}
    for group, ids in (("shortlist", SHORTLIST), ("baseline", BASELINES), ("reconsider", RECONSIDER)):
        for mid in ids:
            print("checking", mid, flush=True)
            v = verify(mid, regs, ttypes)
            v["group"] = group
            try:
                v["tokenizer"] = tokenizer_counts(mid) if v.get("exists") else None
            except Exception as e:  # a gated or non-standard tokenizer is reported, not fatal
                v["tokenizer"] = {"error": repr(e)[:200]}
            out["models"][mid] = v
    (HERE / "model_verification.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    for mid, v in out["models"].items():
        t = v.get("tokenizer") or {}
        z = (t.get("zero_shot_prompt_tokens") or {}).get("all", {})
        print(f"{mid:42s} exists={v.get('exists')} created={str(v.get('created_at'))[:10]} lic={v.get('licence_tag')} "
              f"params={v.get('params_total_safetensors')} arch={(v.get('config') or {}).get('architectures')} "
              f"conv={v.get('llama_cpp_converter_module')} rt={v.get('llama_cpp_runtime_arch_known')} hf={v.get('transformers_native_model_type')} "
              f"urdu={(v.get('card') or {}).get('mentions_urdu')} tok_mean={z.get('mean')}")




# ---------------------------------------------------------------- deployment facts: GGUF files, declared arch, KV cache
GGUF_REPOS = {
    "Qwen/Qwen3-0.6B": "Qwen/Qwen3-0.6B-GGUF", "Qwen/Qwen3-1.7B": "Qwen/Qwen3-1.7B-GGUF",
    "Qwen/Qwen3-4B-Instruct-2507": "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    "Qwen/Qwen3.5-0.8B": "unsloth/Qwen3.5-0.8B-GGUF", "Qwen/Qwen3.5-2B": "unsloth/Qwen3.5-2B-GGUF",
    "Qwen/Qwen3.5-4B": "unsloth/Qwen3.5-4B-GGUF", "google/gemma-4-E2B-it": "google/gemma-4-E2B-it-qat-q4_0-gguf",
    "LiquidAI/LFM3-1.7B": "LiquidAI/LFM3-1.7B-GGUF", "LiquidAI/LFM2.5-2.6B": "LiquidAI/LFM2.5-2.6B-GGUF",
    "ibm-granite/granite-4.2-3b": "ibm-granite/granite-4.2-3b-GGUF",
    "microsoft/Aion-1.0-Instruct-2.3B": "Xylolabs/Aion-1.0-Instruct-2.3B-GGUF",
    "mistralai/Ministral-3-3B-Instruct-2512": "mistralai/Ministral-3-3B-Instruct-2512-GGUF",
    "microsoft/Phi-4-mini-instruct": "unsloth/Phi-4-mini-instruct-GGUF",
    "LiquidAI/LFM2.5-1.2B-Instruct": "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
}


def gguf_arch(repo, fname):
    """Read general.architecture from the GGUF header with an HTTP range request (first 256 KB)."""
    import struct
    url = f"https://huggingface.co/{repo}/resolve/main/{fname}"
    req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-262143"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
    except Exception as e:
        return f"error: {e!r}"[:120]
    if b[:4] != b"GGUF":
        return "not a GGUF header"
    pos = 4 + 4 + 8 + 8
    def rstr(p):
        n = struct.unpack_from("<Q", b, p)[0]
        return b[p + 8:p + 8 + n].decode("utf-8", "replace"), p + 8 + n
    for _ in range(8):  # general.architecture is the first or among the first keys
        k, pos = rstr(pos)
        t = struct.unpack_from("<I", b, pos)[0]
        pos += 4
        if t == 8:
            v, pos = rstr(pos)
            if k == "general.architecture":
                return v
        else:
            size = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}.get(t)
            if size is None:
                return f"unparsed key type {t} before general.architecture"
            pos += size
    return "general.architecture not in the first keys"


def gguf_files(model_id):
    repo = GGUF_REPOS.get(model_id)
    if not repo:
        return None
    tree = get_json(f"https://huggingface.co/api/models/{repo}/tree/main?recursive=1") or []
    files = {t["path"]: round(t.get("size", 0) / 2**30, 2) for t in tree if t.get("path", "").endswith(".gguf")}
    pick = {}
    for want in ("Q4_K_M", "Q4_0", "Q8_0", "BF16"):
        for f, gb in sorted(files.items()):
            if want.lower() in f.lower() and "mmproj" not in f.lower():
                pick[want] = {"file": f, "GiB": gb}
                break
    first = next(iter(pick.values()), None)
    return {"repo": repo, "n_gguf_files": len(files), "selected": pick,
            "mmproj_files": sorted(f for f in files if "mmproj" in f.lower()),
            "declared_arch": gguf_arch(repo, first["file"]) if first else None}


def kv_cache(cfg_raw):
    """Attention KV cache in MiB at f16 for 2K and 8K tokens, counting only layers that keep a growing cache
    (full attention); sliding-window layers are capped at their window; conv / linear-attention layers keep a
    fixed-size state, not counted here."""
    if not cfg_raw:
        return None
    tc = cfg_raw.get("text_config") or cfg_raw
    L = tc.get("num_hidden_layers") or 0
    kvh = tc.get("num_key_value_heads") or tc.get("num_attention_heads") or 0
    hd = tc.get("head_dim") or ((tc.get("hidden_size") or 0) // max(tc.get("num_attention_heads") or 1, 1))
    types = tc.get("layer_types") or ["full_attention"] * L
    full = sum(1 for t in types if t == "full_attention")
    slide = sum(1 for t in types if "sliding" in t)
    win = tc.get("sliding_window") or 0
    per_tok = 2 * kvh * hd * 2  # K and V, f16
    def mib(n):
        return round((full * n + slide * min(n, win or n)) * per_tok / 2**20, 1)
    return {"layers": L, "full_attention_layers": full, "sliding_layers": slide, "sliding_window": win,
            "other_layers": L - full - slide, "kv_heads": kvh, "head_dim": hd,
            "kv_mib_2k": mib(2048), "kv_mib_8k": mib(8192)}


def deployment():
    out = {}
    for mid in list(GGUF_REPOS):
        cfg = get_json(f"https://huggingface.co/{mid}/raw/main/config.json")
        out[mid] = {"gguf": gguf_files(mid), "kv_cache": kv_cache(cfg)}
        print(mid, json.dumps(out[mid])[:400], flush=True)
    path = HERE / "model_verification.json"
    d = json.loads(path.read_text())
    d["deployment"] = out
    path.write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__" and os.environ.get("IRIS_DEPLOYMENT_ONLY"):
    deployment()


if __name__ == "__main__" and not os.environ.get("IRIS_DEPLOYMENT_ONLY"):
    main()
    deployment()
