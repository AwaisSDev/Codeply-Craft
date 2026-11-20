#!/usr/bin/env python3
"""Training/serving template parity for the pilot (EVAL-PLAN A4). No scoring; CPU llama-server, short generations.

For each model, the official Hugging Face chat template (the one the exported GGUF will embed) is given to
llama-server with --chat-template-file, and for a few shared examples we compare:
  1. the prompt text the trainer builds (train.template_text)      vs  the server's /apply-template output
  2. the trainer's prompt token ids (HF tokenizer)                  vs  the token ids the server evaluates for that chat
     request (prompt_tokens of a 1-token completion, and /tokenize of the rendered prompt as the server would)
Writes template_parity.json.

    IRIS_LLAMA_SERVER=... python3 foundation-2026-11/pilot/template_parity.py <gguf dir>
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import types
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
from transformers import AutoTokenizer  # noqa: E402
if "torch" not in sys.modules:
    try:
        import torch  # noqa: F401
    except ImportError:
        import importlib.machinery
        stub = types.ModuleType("torch")
        stub.__spec__ = importlib.machinery.ModuleSpec("torch", None)
        sys.modules["torch"] = stub
from codeply_iris import prompt  # noqa: E402
from codeply_iris import train as T  # noqa: E402

GGUF = {"qwen3-1.7b": "Qwen3-1.7B-Q4_K_M.gguf", "qwen3-4b-2507": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "gemma-4-e2b": "gemma-4-E2B_q4_0-it.gguf"}


def post(url, path, body):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def main(gdir):
    spec = json.loads((HERE / "example-ids.json").read_text())
    rows = {json.loads(l)["id"]: json.loads(l) for f in ("train", "val")
            for l in (ROOT / f"data/built/{f}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}
    sample = spec["train"][:3] + spec["val"][:2]
    out = {}
    for name, (hf, kw) in spec["models"].items():
        tok = AutoTokenizer.from_pretrained(hf)
        tmpl = tok.chat_template if isinstance(tok.chat_template, str) else tok.chat_template.get("default")
        tf = tempfile.NamedTemporaryFile("w", suffix=".jinja", delete=False)
        tf.write(tmpl)
        tf.close()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        proc = subprocess.Popen([os.environ["IRIS_LLAMA_SERVER"], "-m", str(Path(gdir) / GGUF[name]), "--port", str(port), "-c", "4096",
                                 "--parallel", "1", "--no-webui", "-t", "4", "--jinja", "--chat-template-file", tf.name],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = f"http://127.0.0.1:{port}"
        for _ in range(240):
            try:
                urllib.request.urlopen(url + "/health", timeout=2)
                break
            except Exception:
                time.sleep(0.5)
        res = []
        try:
            for i in sample:
                ex = rows[i]
                p, a = T.template_text(tok, ex["prompt"], ex["target"], kw)
                ids, start = T.template_ids(tok, ex["prompt"], ex["target"], kw)
                msgs = prompt.chat_messages(ex["prompt"], prompt.SYSTEM)
                body = {"messages": msgs, **({"chat_template_kwargs": kw} if kw else {})}
                server_prompt = post(url, "/apply-template", body)["prompt"]
                comp = post(url, "/v1/chat/completions", {**body, "max_tokens": 1, "temperature": 0, "cache_prompt": False})
                server_tok = post(url, "/tokenize", {"content": server_prompt, "add_special": True, "parse_special": True})["tokens"]
                res.append({"id": i, "prompt_text_identical": server_prompt == p,
                            "first_text_diff": next((k for k, (x, y) in enumerate(zip(server_prompt, p)) if x != y), None if len(server_prompt) == len(p) else min(len(p), len(server_prompt))),
                            "trainer_prompt_tokens": start, "server_prompt_tokens": comp["usage"]["prompt_tokens"],
                            "server_tokenize_with_special": len(server_tok),
                            "token_ids_identical": server_tok == ids[:start] or server_tok[1:] == ids[:start] and False,
                            "token_ids_identical_exact": server_tok == ids[:start],
                            "answer_tail": a[-24:]})
        finally:
            proc.terminate()
            os.unlink(tf.name)
        out[name] = res
        print(name, json.dumps([{k: r[k] for k in ("prompt_text_identical", "trainer_prompt_tokens", "server_prompt_tokens", "server_tokenize_with_special", "token_ids_identical_exact", "answer_tail")} for r in res], ensure_ascii=False), flush=True)
    (HERE / "template_parity.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
