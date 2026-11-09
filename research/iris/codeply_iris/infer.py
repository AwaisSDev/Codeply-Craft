"""Iris runtime: one predictable interface over two local backends.

    from codeply_iris.infer import Iris
    iris = Iris.load("release/iris-1-q8_0.gguf")            # llama.cpp (GGUF), or a merged Hugging Face directory
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


class Iris:
    def __init__(self, backend, system=prompt.SYSTEM, retrieve_system=None):
        self.backend = backend
        self.system = system
        self.retrieve_system = retrieve_system or system

    @classmethod
    def load(cls, path, adapter=None, threads=0, constrain=False, **kw):
        backend = LlamaBackend(path, threads=threads, constrain=constrain) if str(path).endswith(".gguf") \
            else HFBackend(path, adapter=adapter, threads=threads)
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
        text = prompt.chatml(prompt.observe_prompt(now, source, memories, messages), self.system)
        t = time.time()
        raw, usage = self.backend.generate(text, max_new_tokens, contract.OUTPUT_SCHEMA)
        return raw, {**usage, "ms": round((time.time() - t) * 1000)}

    def observe(self, now, source, memories, messages, max_new_tokens=900):
        """Propose operations for one observation batch. Invalid or ungrounded output is rejected, never applied."""
        mems, back = self._alias(memories)
        raw, stats = self.observe_raw(now, source, mems, messages, max_new_tokens)
        parsed = contract.parse(raw)
        ops, rejected = contract.guard(parsed["ops"], messages, mems, source)
        rejected = [(o, f"schema:{why}") for o, why in parsed["dropped"]] + rejected
        for o in ops:
            if "ref" in o:
                o["ref"] = back[o["ref"]]
        return {"ops": ops, "rejected": rejected, "valid": parsed["ok"], "raw": raw, **stats}

    def retrieve_raw(self, now, memories, query, max_new_tokens=160):
        text = prompt.chatml(prompt.retrieve_prompt(now, memories, query), self.retrieve_system)
        t = time.time()
        raw, usage = self.backend.generate(text, max_new_tokens, contract.USE_SCHEMA)
        return raw, {**usage, "ms": round((time.time() - t) * 1000)}

    def retrieve(self, now, memories, query):
        """Ids of the memories an agent needs for `query` (a subset of `memories`, still valid at `now`)."""
        mems, back = self._alias(memories)
        raw, stats = self.retrieve_raw(now, mems, query)
        parsed = contract.parse_use(raw, set(back))
        return {"use": [back[i] for i in parsed["use"]], "valid": parsed["ok"], "raw": raw, **stats}
