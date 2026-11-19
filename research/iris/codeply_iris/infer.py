"""Iris runtime: one predictable interface over two local backends.

    from codeply_iris.infer import Iris
    iris = Iris.load("iris-1-Q8_0.gguf")     # GGUF via llama-server (or llama-cpp-python), a merged Hugging Face
                                             # directory, or the URL of a running llama-server
    out = iris.observe(now="2026-03-02T09:15", source="personal_chat", memories=[...], messages=[...])
    out["ops"]        # operations that passed the guard: hand these to the store / Brain
    out["rejected"]   # [(op, reason)]: never applied
    ids = iris.retrieve(now=..., memories=[...], query="...")["use"]

Memories may carry any ids; they are aliased to short ids (m1, m2, …) for the model and mapped back.
Nothing here calls a network service: after training, Iris runs without the teacher.
"""
import time

from . import contract, prompt


class HFBackend:
    """Hugging Face transformers on CPU (bf16) or GPU. `adapter` = an unmerged LoRA directory (evaluation of
    checkpoints); a released model is a merged directory and needs no adapter."""

    def __init__(self, path, adapter=None, threads=0):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.torch = torch
        if threads:
            torch.set_num_threads(threads)
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.tok = AutoTokenizer.from_pretrained(path)
        self.model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=torch.bfloat16 if self.device == "cpu" else torch.float16)
        if adapter:
            from peft import PeftModel
            self.model = PeftModel.from_pretrained(self.model, adapter).merge_and_unload()
        self.model.to(self.device).eval()
        self.eos = self.tok.convert_tokens_to_ids("<|im_end|>")
        self.name = f"hf:{adapter or path}"

    def generate(self, text, max_new_tokens=900, schema=None):
        torch = self.torch
        ids = self.tok(text, add_special_tokens=False, return_tensors="pt")["input_ids"].to(self.device)
        with torch.no_grad(), torch.autocast(self.device, dtype=torch.bfloat16 if self.device == "cpu" else torch.float16):
            out = self.model.generate(ids, max_new_tokens=max_new_tokens, do_sample=False, eos_token_id=self.eos,
                                      pad_token_id=self.eos, repetition_penalty=1.0)
        new = out[0, ids.shape[1]:]
        return self.tok.decode(new, skip_special_tokens=True), {"prompt_tokens": ids.shape[1], "new_tokens": int(new.shape[0])}


class LlamaBackend:
    """llama.cpp through llama-cpp-python. `constrain=True` decodes under the contract's JSON Schema."""

    def __init__(self, gguf, n_ctx=8192, threads=0, constrain=False):
        import llama_cpp
        self.llama_cpp = llama_cpp
        self.llm = llama_cpp.Llama(model_path=str(gguf), n_ctx=n_ctx, n_threads=threads or None, verbose=False)
        self.constrain = constrain
        self._grammars = {}
        self.name = f"gguf:{gguf}"

    def _grammar(self, schema):
        import json
        key = id(schema)
        if key not in self._grammars:
            self._grammars[key] = self.llama_cpp.LlamaGrammar.from_json_schema(json.dumps(schema), verbose=False)
        return self._grammars[key]

    def generate(self, text, max_new_tokens=900, schema=None):
        kw = {"grammar": self._grammar(schema)} if (self.constrain and schema) else {}
        r = self.llm.create_completion(text, max_tokens=max_new_tokens, temperature=0.0, stop=["<|im_end|>"], **kw)
        u = r.get("usage", {})
        return r["choices"][0]["text"], {"prompt_tokens": u.get("prompt_tokens", 0), "new_tokens": u.get("completion_tokens", 0)}


class ServerBackend:
    """llama.cpp's `llama-server`, started and owned by this process (as Codeply's local runtime does) or reached
    at `url`. The binary comes from $IRIS_LLAMA_SERVER or PATH. `constrain=True` sends the contract's JSON Schema."""

    def __init__(self, gguf=None, url=None, threads=0, n_ctx=8192, constrain=False, port=0):
        import atexit
        import os
        import shutil
        import socket
        import subprocess
        import urllib.request
        self.constrain = constrain
        self.proc = None
        if url:
            self.url = url.rstrip("/")
        else:
            exe = os.environ.get("IRIS_LLAMA_SERVER") or shutil.which("llama-server")
            if not exe:
                raise RuntimeError("llama-server not found: set IRIS_LLAMA_SERVER or put it on PATH")
            if not port:
                with socket.socket() as sock:
                    sock.bind(("127.0.0.1", 0))
                    port = sock.getsockname()[1]
            cmd = self._server_cmd(exe, gguf, port, threads or os.cpu_count() or 4, n_ctx)
            self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            atexit.register(self.close)
            self.url = f"http://127.0.0.1:{port}"
            t0 = time.time()
            while True:
                try:
                    with urllib.request.urlopen(self.url + "/health", timeout=2) as r:
                        if r.status == 200:
                            break
                except Exception:
                    if self.proc.poll() is not None:
                        raise RuntimeError(f"llama-server exited with code {self.proc.returncode}")
                    if time.time() - t0 > 180:
                        raise RuntimeError("llama-server did not become healthy in 180 s")
                    time.sleep(0.5)
        self.name = f"llama-server:{gguf or url}"

    def _server_cmd(self, exe, gguf, port, threads, n_ctx):
        return [exe, "-m", str(gguf), "--host", "127.0.0.1", "--port", str(port), "-c", str(n_ctx), "--parallel", "1",
                "--no-webui", "-t", str(threads)]

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def generate(self, text, max_new_tokens=900, schema=None):
        import json
        import urllib.request
        body = {"prompt": text, "n_predict": max_new_tokens, "temperature": 0.0, "stop": ["<|im_end|>"], "cache_prompt": False}
        if self.constrain and schema:
            body["json_schema"] = schema
        req = urllib.request.Request(self.url + "/completion", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=900) as r:
            out = json.load(r)
        return out.get("content", ""), {"prompt_tokens": out.get("tokens_evaluated", 0), "new_tokens": out.get("tokens_predicted", 0)}


def split_think(raw):
    """Separate a leading reasoning block from the answer: (answer, think_text, closed).

    Applied identically to every model on the chat path. `<think>...</think>` at the start (after whitespace) is
    removed; an unclosed `<think>` (generation stopped while reasoning) leaves an empty answer, i.e. nothing stored.
    Text without a think block is returned unchanged, so non-reasoning outputs are untouched.
    """
    s = raw or ""
    stripped = s.lstrip()
    if not stripped.startswith("<think>"):
        return s, "", True
    end = stripped.find("</think>")
    if end < 0:
        return "", stripped[len("<think>"):], False
    return stripped[end + len("</think>"):].lstrip(), stripped[len("<think>"):end], True


class ChatServerBackend(ServerBackend):
    """llama-server's OpenAI-style chat endpoint with the model's **own** chat template (`--jinja`, the template
    embedded in the GGUF). Same process handling as ServerBackend; what differs is that the prompt is sent as
    messages, so Gemma, Granite, Mistral or LFM formatting is the model's, not Qwen's ChatML.

    template_kwargs: passed as `chat_template_kwargs` (e.g. {"enable_thinking": false}).
    llama-server's default reasoning parser (`--reasoning-format auto`) returns reasoning text separately
    (`reasoning_content`); it is kept and measured (think leaks), never parsed as the answer. `none` is not used: on
    llama.cpp 7a4117e it makes grammar initialisation fail whenever thinking is off and a JSON Schema is set
    (stage-0 finding). Any `<think>` block left in the content is stripped too, the same way for every model.
    Greedy decoding (temperature 0, top-k 1, seed 0), no prompt cache, optional JSON-Schema constraint and
    per-token log-probabilities.
    """
    chat = True

    def __init__(self, gguf=None, url=None, threads=0, n_ctx=8192, constrain=False, port=0, template_kwargs=None,
                 logprobs=True, extra_args=()):
        self.template_kwargs = dict(template_kwargs or {})
        self.logprobs = logprobs
        self.extra_args = list(extra_args)
        super().__init__(gguf=gguf, url=url, threads=threads, n_ctx=n_ctx, constrain=constrain, port=port)
        self.name = f"llama-server-chat:{gguf or url}"

    def _server_cmd(self, exe, gguf, port, threads, n_ctx):
        return super()._server_cmd(exe, gguf, port, threads, n_ctx) + ["--jinja", "--reasoning-format", "auto"] + self.extra_args

    def request_body(self, system, user, max_new_tokens=900, schema=None):
        body = {"messages": prompt.chat_messages(user, system), "max_tokens": max_new_tokens, "temperature": 0.0,
                "top_k": 1, "top_p": 1.0, "min_p": 0.0, "seed": 0, "repeat_penalty": 1.0, "presence_penalty": 0.0,
                "frequency_penalty": 0.0, "cache_prompt": False}
        if self.template_kwargs:
            body["chat_template_kwargs"] = self.template_kwargs
        if self.constrain and schema:
            body["json_schema"] = schema
        if self.logprobs:
            body["logprobs"] = True
        return body

    def apply_template(self, system, user):
        """The exact prompt string the server builds for these messages (llama-server /apply-template)."""
        import json
        import urllib.request
        body = {"messages": prompt.chat_messages(user, system)}
        if self.template_kwargs:
            body["chat_template_kwargs"] = self.template_kwargs
        req = urllib.request.Request(self.url + "/apply-template", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r).get("prompt", "")

    def generate_chat(self, system, user, max_new_tokens=900, schema=None):
        import json
        import urllib.request
        body = self.request_body(system, user, max_new_tokens, schema)
        req = urllib.request.Request(self.url + "/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=1800) as r:
            out = json.load(r)
        ch = out["choices"][0]
        msg = ch.get("message") or {}
        raw = msg.get("content") or ""
        reasoning = msg.get("reasoning_content") or ""
        u = out.get("usage", {})
        lp = None
        if ch.get("logprobs") and ch["logprobs"].get("content") is not None:
            lp = [[t.get("token", ""), round(float(t.get("logprob", 0.0)), 5)] for t in ch["logprobs"]["content"]]
        answer, think, closed = split_think(raw)
        if reasoning and not raw.strip() and ch.get("finish_reason") == "length":
            closed = False                              # stopped while reasoning: nothing to store
        return raw, {"prompt_tokens": u.get("prompt_tokens", 0), "new_tokens": u.get("completion_tokens", 0),
                     "finish_reason": ch.get("finish_reason"), "answer": answer, "reasoning": reasoning,
                     "think_chars": len(think) + len(reasoning), "think_closed": closed, "logprobs": lp}


class Iris:
    def __init__(self, backend, system=prompt.SYSTEM, retrieve_system=None, answer_prefix=""):
        self.backend = backend
        self.system = system
        self.retrieve_system = retrieve_system or system
        self.answer_prefix = answer_prefix          # baselines only: e.g. an empty think block for untrained Qwen3

    @classmethod
    def load(cls, path, adapter=None, threads=0, constrain=False, chat=False, template_kwargs=None, logprobs=True,
             server_args=(), **kw):
        if chat:                                       # model's own chat template through llama-server
            url = path if str(path).startswith(("http://", "https://")) else None
            backend = ChatServerBackend(gguf=None if url else path, url=url, threads=threads, constrain=constrain,
                                        template_kwargs=template_kwargs, logprobs=logprobs, extra_args=server_args)
            return cls(backend, **kw)
        if str(path).startswith("http://") or str(path).startswith("https://"):
            backend = ServerBackend(url=path, constrain=constrain)
        elif str(path).endswith(".gguf"):
            try:
                backend = ServerBackend(path, threads=threads, constrain=constrain)
            except RuntimeError:
                backend = LlamaBackend(path, threads=threads, constrain=constrain)
        else:
            backend = HFBackend(path, adapter=adapter, threads=threads)
        return cls(backend, **kw)

    @staticmethod
    def _alias(memories):
        """Short ids for the model; returns (aliased memories, alias -> original id)."""
        if all(contract.REF_RE.match(str(m.get("id", ""))) for m in memories):
            return list(memories), {m["id"]: m["id"] for m in memories}
        back, out = {}, []
        for i, m in enumerate(memories, 1):
            back[f"m{i}"] = m["id"]
            out.append({**m, "id": f"m{i}"})
        return out, back

    def observe_raw(self, now, source, memories, messages, max_new_tokens=900):
        user = prompt.observe_prompt(now, source, memories, messages)
        t = time.time()
        if getattr(self.backend, "chat", False):       # model's own chat template; answer_prefix is not used
            raw, usage = self.backend.generate_chat(self.system, user, max_new_tokens, contract.OUTPUT_SCHEMA)
        else:
            text = prompt.chatml(user, self.system) + self.answer_prefix
            raw, usage = self.backend.generate(text, max_new_tokens, contract.OUTPUT_SCHEMA)
        return raw, {**usage, "ms": round((time.time() - t) * 1000)}

    def observe(self, now, source, memories, messages, max_new_tokens=900):
        """Propose operations for one observation batch. Invalid or ungrounded output is rejected, never applied."""
        mems, back = self._alias(memories)
        raw, stats = self.observe_raw(now, source, mems, messages, max_new_tokens)
        parsed = contract.parse(stats.get("answer", raw))
        ops, rejected = contract.guard(parsed["ops"], messages, mems, source)
        rejected = [(o, f"schema:{why}") for o, why in parsed["dropped"]] + rejected
        for o in ops:
            if "ref" in o:
                o["ref"] = back[o["ref"]]
        return {"ops": ops, "rejected": rejected, "valid": parsed["ok"], "raw": raw, **stats}

    def retrieve_raw(self, now, memories, query, max_new_tokens=160):
        user = prompt.retrieve_prompt(now, memories, query)
        t = time.time()
        if getattr(self.backend, "chat", False):
            raw, usage = self.backend.generate_chat(self.retrieve_system, user, max_new_tokens, contract.USE_SCHEMA)
        else:
            text = prompt.chatml(user, self.retrieve_system) + self.answer_prefix
            raw, usage = self.backend.generate(text, max_new_tokens, contract.USE_SCHEMA)
        return raw, {**usage, "ms": round((time.time() - t) * 1000)}

    def retrieve(self, now, memories, query):
        """Ids of the memories an agent needs for `query` (a subset of `memories`, still valid at `now`)."""
        mems, back = self._alias(memories)
        raw, stats = self.retrieve_raw(now, mems, query)
        parsed = contract.parse_use(stats.get("answer", raw), set(back))
        return {"use": [back[i] for i in parsed["use"]], "valid": parsed["ok"], "raw": raw, **stats}
