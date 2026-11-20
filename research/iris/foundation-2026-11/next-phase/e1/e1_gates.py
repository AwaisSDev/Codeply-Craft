#!/usr/bin/env python3
"""E1 template gates (E1-PROTOCOL §2.1). No scoring, no generation beyond nothing: prompt strings and token ids only.

TG1  r2 / r3 GGUF chat path: llama-server --jinja --chat-template-file chatml_raw.jinja; /apply-template must equal
     prompt.chatml(user, SYSTEM) byte for byte (observe and retrieve prompts).
TG2  pilot: prompt.chatml(user, SYSTEM) + "<think>\\n\\n</think>\\n\\n" (the E1 Transformers path) must equal the official
     template (HF tokenizer at the pinned revision, enable_thinking=False) AND llama-server's /apply-template with the
     template embedded in the pilot GGUF (the seed-1 chat path).
Also reported (TOK): HF tokenizer ids of each gate string vs llama-server /tokenize ids (special tokens parsed).

Sessions: the first 10 observe and first 5 retrieve validation examples by id.

    IRIS_LLAMA_SERVER=<llama-server> python3 e1_gates.py --tokenizer <hf dir or repo> --gguf-r2 <gguf> --gguf-pilot <gguf> \
        [--revision <sha>] --out gates.json
Exit code 0 only if TG1 and TG2 pass. Either GGUF may be any Qwen3-1.7B GGUF for TG1 (the template is supplied).
"""
import argparse, json, os, socket, subprocess, sys, time, urllib.request
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))
from codeply_iris import prompt  # noqa: E402

THINK_OFF = "<think>\n\n</think>\n\n"


def post(url, path, body):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


class Server:
    def __init__(self, gguf, extra=()):
        exe = os.environ.get("IRIS_LLAMA_SERVER", "llama-server")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.p = subprocess.Popen([exe, "-m", gguf, "--host", "127.0.0.1", "--port", str(port), "-c", "8192", "--jinja",
                                   "--reasoning-format", "auto", "--no-webui", "-ngl", "0", *extra],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        t = time.time()
        while True:
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=2) as r:
                    if r.status == 200:
                        break
            except Exception:
                if self.p.poll() is not None or time.time() - t > 300:
                    raise RuntimeError("llama-server failed to start")
                time.sleep(0.5)

    def render(self, system, user, kw=None):
        body = {"messages": prompt.chat_messages(user, system)}
        if kw:
            body["chat_template_kwargs"] = kw
        return post(self.url, "/apply-template", body)["prompt"]

    def tokenize(self, text):
        return post(self.url, "/tokenize", {"content": text, "add_special": False, "parse_special": True})["tokens"]

    def close(self):
        self.p.terminate()


def cases():
    rows = [json.loads(l) for l in (ROOT / "data/built/val.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    rows.sort(key=lambda e: e["id"])
    obs = [e for e in rows if e["task"] == "observe"][:10]
    ret = [e for e in rows if e["task"] != "observe"][:5]
    out = []
    for e in obs:
        shown = [{k: v for k, v in m.items() if k != "key"} for m in e["memories"]]
        out.append((e["id"], prompt.observe_prompt(e["now"], e["source"], shown, e["messages"])))
    for e in ret:
        shown = [{k: v for k, v in m.items() if k != "key"} for m in e["memories"]]
        out.append((e["id"], prompt.retrieve_prompt(e["now"], shown, e["query"])))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--revision", default=None)
    ap.add_argument("--gguf-r2", required=True)
    ap.add_argument("--gguf-pilot", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer, revision=a.revision)
    cs = cases()
    res = {"sessions": [i for i, _ in cs], "template_sha256": __import__("hashlib").sha256((HERE / "chatml_raw.jinja").read_bytes()).hexdigest()}

    s1 = Server(a.gguf_r2, ["--chat-template-file", str(HERE / "chatml_raw.jinja")])
    tg1, tok1 = [], []
    for i, user in cs:
        want = prompt.chatml(user, prompt.SYSTEM)
        got = s1.render(prompt.SYSTEM, user)
        tg1.append(got == want)
        tok1.append(s1.tokenize(want) == tok(want, add_special_tokens=False)["input_ids"])
    s1.close()

    s2 = Server(a.gguf_pilot)
    tg2_hf, tg2_srv, tok2 = [], [], []
    for i, user in cs:
        want = prompt.chatml(user, prompt.SYSTEM) + THINK_OFF
        hf = tok.apply_chat_template(prompt.chat_messages(user, prompt.SYSTEM), tokenize=False, add_generation_prompt=True,
                                     enable_thinking=False)
        srv = s2.render(prompt.SYSTEM, user, {"enable_thinking": False})
        tg2_hf.append(hf == want)
        tg2_srv.append(srv == want)
        tok2.append(s2.tokenize(want) == tok(want, add_special_tokens=False)["input_ids"])
    s2.close()

    res.update({"TG1_pass": all(tg1), "TG1_matches": sum(tg1),
                "TG2_pass": all(tg2_hf) and all(tg2_srv), "TG2_hf_matches": sum(tg2_hf), "TG2_server_matches": sum(tg2_srv),
                "TOK_r2_matches": sum(tok1), "TOK_pilot_matches": sum(tok2), "n": len(cs)})
    Path(a.out).write_text(json.dumps(res, indent=1) + "\n")
    print(json.dumps(res, indent=1))
    sys.exit(0 if res["TG1_pass"] and res["TG2_pass"] else 1)


if __name__ == "__main__":
    main()
