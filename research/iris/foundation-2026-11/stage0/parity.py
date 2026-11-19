#!/usr/bin/env python3
"""Stage-0 checks of the chat-template backend (EVAL-PLAN §7, stage 0). Small runs only; nothing is scored.

    parity     one Qwen3 GGUF, the first N val observe sessions, zero-shot prompt v1, constrained:
               raw-ChatML path (/completion + empty think prefix, the path every earlier zero-shot result used) vs
               chat path (/v1/chat/completions, the GGUF's own template, enable_thinking=false).
               Pass = the rendered prompt strings are identical and the greedy outputs are identical.
    templates  for every GGUF given: the prompt the server builds for one val session (system + user), saved with
               its first and last characters, and whether the system text and the user text appear in it verbatim.

    IRIS_LLAMA_SERVER=/path/llama-server python3 foundation-2026-11/stage0/parity.py parity <qwen3.gguf> [N]
    IRIS_LLAMA_SERVER=... python3 foundation-2026-11/stage0/parity.py templates <name>=<gguf>[:<template kwargs json>] ...
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
from codeply_iris import contract, prompt  # noqa: E402
from codeply_iris.infer import ChatServerBackend, ServerBackend, split_think  # noqa: E402

EXE = os.environ.get("IRIS_LLAMA_SERVER", "llama-server")


def start(gguf):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen([EXE, "-m", gguf, "--host", "127.0.0.1", "--port", str(port), "-c", "8192", "--parallel", "1",
                             "--no-webui", "-t", "4", "--jinja", "--reasoning-format", "auto"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"
    for _ in range(600):
        try:
            with urllib.request.urlopen(url + "/health", timeout=2) as r:
                if r.status == 200:
                    return proc, url
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError("llama-server exited")
            time.sleep(0.5)
    raise RuntimeError("llama-server not healthy")


def val_sessions(n):
    rows = [json.loads(l) for l in (ROOT / "data" / "built" / "val.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    obs = [r for r in rows if r["task"] == "observe"]
    return obs[:n]


def user_text(ex):
    shown = [{k: v for k, v in m.items() if k != "key"} for m in ex["memories"]]
    return prompt.observe_prompt(ex["now"], ex["source"], shown, ex["messages"])


def _json(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def parity(gguf, n=10):
    proc, url = start(gguf)
    try:
        raw_b = ServerBackend(url=url, constrain=True)
        chat_b = ChatServerBackend(url=url, constrain=True, template_kwargs={"enable_thinking": False}, logprobs=True)
        system = prompt.ZERO_SHOT_SYSTEM
        rows = []
        for ex in val_sessions(n):
            u = user_text(ex)
            raw_prompt = prompt.chatml(u, system) + "<think>\n\n</think>\n\n"
            chat_prompt = chat_b.apply_template(system, u)
            t = time.time()
            raw_out, _ = raw_b.generate(raw_prompt, 900, contract.OUTPUT_SCHEMA)
            t_raw = time.time() - t
            t = time.time()
            chat_out, st = chat_b.generate_chat(system, u, 900, contract.OUTPUT_SCHEMA)
            t_chat = time.time() - t
            rows.append({"id": ex["id"], "prompt_identical": raw_prompt == chat_prompt,
                         "prompt_diff_at": next((i for i, (a, b) in enumerate(zip(raw_prompt, chat_prompt)) if a != b),
                                                None if len(raw_prompt) == len(chat_prompt) else min(len(raw_prompt), len(chat_prompt))),
                         "output_identical": raw_out == st["answer"], "raw_chars": len(raw_out), "chat_chars": len(chat_out),
                         "think_chars": st["think_chars"], "logprob_tokens": len(st["logprobs"] or []),
                         "ops_identical": contract.parse(raw_out)["ops"] == contract.parse(st["answer"])["ops"],
                         "json_identical": _json(raw_out) == _json(st["answer"]),
                         "logprob_text_matches": "".join(t for t, _ in (st["logprobs"] or [])).strip() == chat_out.strip(),
                         "seconds_raw": round(t_raw, 1), "seconds_chat": round(t_chat, 1),
                         "parsed_ops_raw": len(contract.parse(raw_out)["ops"]), "parsed_ops_chat": len(contract.parse(st["answer"])["ops"])})
            print(json.dumps(rows[-1]), flush=True)
        res = {"gguf": Path(gguf).name, "sessions": len(rows), "prompt_identical": sum(r["prompt_identical"] for r in rows),
               "output_identical": sum(r["output_identical"] for r in rows),
               "json_identical": sum(r["json_identical"] for r in rows), "ops_identical": sum(r["ops_identical"] for r in rows),
               "logprob_text_matches": sum(r["logprob_text_matches"] for r in rows), "rows": rows}
        (HERE / "parity.json").write_text(json.dumps(res, indent=1) + "\n")
        print({k: v for k, v in res.items() if k != "rows"})
    finally:
        proc.terminate()


def templates(specs):
    ex = val_sessions(1)[0]
    u = user_text(ex)
    system = prompt.ZERO_SHOT_SYSTEM_V11
    out_path = HERE / "templates.json"
    out = json.loads(out_path.read_text()) if out_path.exists() else {}
    for spec in specs:
        name, rest = spec.split("=", 1)
        gguf, _, kw = rest.partition(":")
        kwargs = json.loads(kw) if kw else {}
        proc, url = start(gguf)
        try:
            b = ChatServerBackend(url=url, template_kwargs=kwargs)
            p = b.apply_template(system, u)
            # one short unconstrained generation to see what the model emits first (no scoring)
            raw, st = b.generate_chat(system, u, 64, None)
        finally:
            proc.terminate()
        out[name] = {"gguf": Path(gguf).name, "template_kwargs": kwargs, "prompt_chars": len(p),
                     "system_verbatim": system.strip() in p, "user_verbatim": u in p,
                     "head": p[:220], "tail": p[-160:], "first_64_tokens_unconstrained": raw[:400],
                     "think_block_at_start": raw.lstrip().startswith("<think>"), "finish_reason": st["finish_reason"]}
        print(name, json.dumps({k: out[name][k] for k in ("system_verbatim", "user_verbatim", "think_block_at_start")}),
              repr(out[name]["tail"][-80:]), flush=True)
        out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    if sys.argv[1] == "parity":
        parity(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 10)
    else:
        templates(sys.argv[2:])
