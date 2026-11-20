#!/usr/bin/env python3
"""E1 Transformers (setup T) cells: the unchanged `HFBackend` + the unchanged `evaluate` loops (E1-PROTOCOL §2.2).

Adds only (nothing existing is modified; evaluate.make_system is replaced at run time in this process):
  * the adapter's training-format answer prefix ("" for r2 / r3, the empty think block for the pilot), passed as
    Iris(answer_prefix=...) on the raw ChatML path;
  * optional per-token log-probability capture: the same `model.generate` call as HFBackend.generate, plus one logits
    processor that records log_softmax(scores).max() at each step and returns the scores unchanged (greedy picks that
    argmax). Tokens are mapped to characters through their byte-level BPE bytes, so the joined token text equals the
    decoded answer; if it does not for a session, that session's logprobs are None (counted, never imputed).

    python3 e1_run.py --base <hf snapshot dir> --adapter <lora dir> --prefix none|think --out <dir> [--closed-loop] [--no-capture]
    python3 e1_run.py --base ... --adapter ... --prefix ... --sc1 <json>     # SC1: capture must not change text
"""
import argparse, hashlib, json, sys, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))
from codeply_iris import evaluate as E, prompt  # noqa: E402
from codeply_iris.infer import HFBackend, Iris  # noqa: E402

PREFIX = {"none": "", "think": "<think>\n\n</think>\n\n"}


def _byte_decoder():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {chr(c): b for b, c in zip(bs, cs)}


class ScoredHFBackend(HFBackend):
    def __init__(self, *a, capture=True, **kw):
        super().__init__(*a, **kw)
        self.capture = capture
        self.bd = _byte_decoder()
        self.special = set(self.tok.all_special_ids)
        self.align_fail = 0
        if capture:
            self.name += "+logprobs"

    def _token_texts(self, ids):
        """Per-token text such that ''.join(...) == the UTF-8 decoding of all tokens' bytes."""
        out, pending = [], b""
        for t in self.tok.convert_ids_to_tokens(ids):
            if all(ch in self.bd for ch in t):
                pending += bytes(self.bd[ch] for ch in t)
            else:                                           # added (non-byte-level) token such as <think>
                pending += t.encode("utf-8")
            text = ""
            for cut in range(len(pending), 0, -1):          # longest decodable prefix; the rest waits for the next token
                try:
                    text = pending[:cut].decode("utf-8")
                    pending = pending[cut:]
                    break
                except UnicodeDecodeError:
                    continue
            out.append(text)
        if pending:
            out[-1] += pending.decode("utf-8", errors="replace")
        return out

    def generate(self, text, max_new_tokens=900, schema=None):
        if not self.capture:
            return super().generate(text, max_new_tokens, schema)
        torch = self.torch
        from transformers import LogitsProcessor, LogitsProcessorList
        rec = []

        class Rec(LogitsProcessor):
            def __call__(self, input_ids, scores):
                rec.append(torch.log_softmax(scores.float(), dim=-1).max(dim=-1).values[0])
                return scores

        ids = self.tok(text, add_special_tokens=False, return_tensors="pt")["input_ids"].to(self.device)
        with torch.no_grad(), torch.autocast(self.device, dtype=torch.bfloat16 if self.device == "cpu" else torch.float16):
            out = self.model.generate(ids, max_new_tokens=max_new_tokens, do_sample=False, eos_token_id=self.eos,
                                      pad_token_id=self.eos, repetition_penalty=1.0, logits_processor=LogitsProcessorList([Rec()]))
        new = out[0, ids.shape[1]:]
        decoded = self.tok.decode(new, skip_special_tokens=True)
        lps = torch.stack(rec).tolist() if rec else []
        keep = [(int(i), lp) for i, lp in zip(new.tolist(), lps) if int(i) not in self.special]
        texts = self._token_texts([i for i, _ in keep])
        lp = [[t, round(float(x), 5)] for t, (_, x) in zip(texts, keep)]
        if "".join(texts) != decoded:
            self.align_fail += 1
            lp = None
        return decoded, {"prompt_tokens": ids.shape[1], "new_tokens": int(new.shape[0]), "answer": decoded, "logprobs": lp}


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def versions():
    import importlib
    v = {}
    for m in ("torch", "transformers", "peft", "accelerate"):
        try:
            v[m] = importlib.import_module(m).__version__
        except Exception as e:                              # noqa: BLE001
            v[m] = f"unavailable: {e}"
    try:
        import torch
        v["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
    except Exception:                                       # noqa: BLE001
        pass
    return v


def sc1(a):
    """First 10 observe validation sessions by id: text with and without capture must be identical."""
    b = ScoredHFBackend(a.base, adapter=a.adapter, capture=True)
    rows = sorted((json.loads(l) for l in (ROOT / "data/built/val.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()),
                  key=lambda e: e["id"])
    same, ids, t0 = [], [], time.time()
    for e in [r for r in rows if r["task"] == "observe"][:10]:
        shown = [{k: v for k, v in m.items() if k != "key"} for m in e["memories"]]
        text = prompt.chatml(prompt.observe_prompt(e["now"], e["source"], shown, e["messages"]), prompt.SYSTEM) + PREFIX[a.prefix]
        plain, _ = HFBackend.generate(b, text, 900)
        scored, st = b.generate(text, 900)
        same.append(plain == scored)
        ids.append(e["id"])
    res = {"SC1_pass": all(same), "identical": sum(same), "n": len(same), "sessions": ids, "align_fail": b.align_fail,
           "seconds": round(time.time() - t0), "versions": versions()}
    Path(a.sc1).write_text(json.dumps(res, indent=1) + "\n")
    print(json.dumps(res), flush=True)
    sys.exit(0 if res["SC1_pass"] else 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--prefix", required=True, choices=sorted(PREFIX))
    ap.add_argument("--out")
    ap.add_argument("--label", default="")
    ap.add_argument("--closed-loop", action="store_true")
    ap.add_argument("--no-capture", action="store_true")
    ap.add_argument("--sc1")
    a = ap.parse_args()
    if a.sc1:
        return sc1(a)
    holder = {}

    def make_system(ea):
        b = ScoredHFBackend(ea.model, adapter=ea.adapter, capture=not a.no_capture)
        holder["b"] = b
        return Iris(b, answer_prefix=PREFIX[a.prefix])

    E.make_system = make_system
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    loop = "closed" if a.closed_loop else "open"
    t0 = time.time()
    E.main(["--system", "iris", "--model", a.base, "--adapter", a.adapter, "--split", "val", "--out", str(out),
            "--label", a.label or out.name] + (["--closed-loop"] if a.closed_loop else []))
    man = {"setup": "T (transformers fp16, unconstrained)", "prefix": a.prefix, "answer_prefix": PREFIX[a.prefix],
           "logprob_capture": not a.no_capture, "logprob_align_fail_sessions": holder["b"].align_fail if "b" in holder else None,
           "adapter_sha256": sha(Path(a.adapter, "adapter_model.safetensors")), "base_dir": a.base,
           "versions": versions(), "minutes": round((time.time() - t0) / 60, 1)}
    (out / f"E1-MANIFEST-val-{loop}.json").write_text(json.dumps(man, indent=1) + "\n")


if __name__ == "__main__":
    main()
