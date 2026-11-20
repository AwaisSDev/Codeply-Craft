"""P0 smoke test of the matched LoRA pilot (EVAL-PLAN A4). Validation and train data only; the test split is absent.

Per model (Qwen3-1.7B, Qwen3-4B-Instruct-2507, Gemma 4 E2B), on a Kaggle T4, with the exact pilot config:
  1. template parity: train.template_ids prompt-token counts equal the counts verified locally against llama-server
     (foundation-2026-11/pilot/template_parity.json)
  2. fp16 headroom: one forward pass in fp16 autocast over the 3 longest shared val examples with hooks on every decoder
     layer; records the largest absolute activation (fp16 overflows at 65,504) and whether logits and loss are finite
  3. training: the real trainer (codeply_iris.train) for 5 minutes: loss values, non-finite / out-of-memory skips,
     peak GPU memory, tokens per second, LoRA module count
Gate (per model): template parity holds, every recorded value finite, max activation < 30,000 (2x headroom), no
non-finite or OOM skip, peak memory < 14.5 GiB. Results: /kaggle/working/smoke/report.json.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import time

T0 = time.time()
W = "/kaggle/working"
OUT = f"{W}/smoke"
os.makedirs(OUT, exist_ok=True)
MODELS = ["qwen3-1.7b", "qwen3-4b-2507", "gemma-4-e2b"]
PINS = "transformers==5.23.0 peft==0.22.0 accelerate==1.16.0"


def sh(cmd):
    print("+", cmd[:200], flush=True)
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


smi = sh("nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader").stdout.strip()
print(smi, flush=True)
if "T4" not in smi:
    raise SystemExit("no T4 attached")
r = sh(f"{sys.executable} -m pip install -q {PINS}")
print(r.stdout[-500:], r.stderr[-1500:], flush=True)

init = sorted(glob.glob("/kaggle/input/**/codeply_iris/__init__.py", recursive=True))
if not init:
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    init = sorted(glob.glob(f"{W}/src/**/codeply_iris/__init__.py", recursive=True))
SRC = f"{W}/iris"
shutil.copytree(os.path.dirname(os.path.dirname(init[0])), SRC, dirs_exist_ok=True)
assert not os.path.exists(f"{SRC}/data/raw/test") and not os.path.exists(f"{SRC}/data/built/test.jsonl"), "test split present"
os.environ["HF_HOME"] = "/tmp/hf"

PROBE = r'''
import json, sys, torch
sys.path.insert(0, ".")
from codeply_iris import train as T
from transformers import AutoModelForCausalLM, AutoTokenizer
name, cfgp, out = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(cfgp))
spec = json.load(open("foundation-2026-11/pilot/example-ids.json"))
parity = json.load(open("foundation-2026-11/pilot/template_parity.json"))[name]
tok = AutoTokenizer.from_pretrained(cfg["base"])
rows = {json.loads(l)["id"]: json.loads(l) for f in ("train", "val") for l in open(f"data/built/{f}.jsonl") if l.strip()}
res = {"versions": {"torch": torch.__version__, "transformers": __import__("transformers").__version__, "peft": __import__("peft").__version__}}
res["template_parity"] = all(T.template_ids(tok, rows[p["id"]]["prompt"], rows[p["id"]]["target"], cfg["template_kwargs"])[1] == p["trainer_prompt_tokens"] for p in parity)
model = AutoModelForCausalLM.from_pretrained(cfg["base"], torch_dtype=torch.float16).cuda().eval()
lm = T.get_lm(model)
peak = {"act": 0.0}
def hook(_m, _i, o):
    t = o[0] if isinstance(o, tuple) else o
    if torch.is_tensor(t):
        v = t.detach().float().abs().max().item()
        peak["act"] = max(peak["act"], v if v == v else float("inf"))
layers = [m for n, m in model.named_modules() if n.split(".")[-2:-1] == ["layers"] and ("language_model" in n or "model.layers" in n)]
hs = [m.register_forward_hook(hook) for m in layers]
vex = sorted((rows[i] for i in spec["val"]), key=lambda e: -len(e["prompt"]))[:3]
losses = []
with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
    for ex in vex:
        ids, start = T.template_ids(tok, ex["prompt"], ex["target"], cfg["template_kwargs"])
        losses.append(T.answer_loss(lm, torch.tensor(ids).cuda(), start).item())
for h in hs:
    h.remove()
res.update({"decoder_layers_hooked": len(layers), "max_abs_activation_fp16": peak["act"], "zero_shot_answer_loss": losses,
            "softcap": T.logit_softcap(lm), "finite": all(l == l and abs(l) != float("inf") for l in losses) and peak["act"] != float("inf")})
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res))
'''
open(f"{SRC}/probe.py", "w").write(PROBE)


def run_model(name, gpu):
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu), PYTHONUNBUFFERED="1", TOKENIZERS_PARALLELISM="false")
    cfg = f"foundation-2026-11/pilot/configs/{name}.json"
    t = time.time()
    p = subprocess.run(f"{sys.executable} probe.py {name} {cfg} {OUT}/probe-{name}.json", shell=True, cwd=SRC, env=env,
                       capture_output=True, text=True)
    open(f"{OUT}/probe-{name}.log", "w").write(p.stdout + p.stderr)
    probe_s = round(time.time() - t)
    t = time.time()
    q = subprocess.run(f"{sys.executable} -m codeply_iris.train --config {cfg} --set out={OUT}/train-{name} --max-minutes 5",
                       shell=True, cwd=SRC, env=env, capture_output=True, text=True)
    open(f"{OUT}/train-{name}.log", "w").write(q.stdout + q.stderr)
    return {"probe_exit": p.returncode, "probe_seconds": probe_s, "train_exit": q.returncode, "train_seconds": round(time.time() - t)}


# GPU 0: Qwen3-4B; GPU 1: Qwen3-1.7B then Gemma (the planned training layout)
import threading
runs = {}
def worker(gpu, names):
    for n in names:
        runs[n] = run_model(n, gpu)
ths = [threading.Thread(target=worker, args=(0, ["qwen3-4b-2507"])), threading.Thread(target=worker, args=(1, ["qwen3-1.7b", "gemma-4-e2b"]))]
for t in ths:
    t.start()
for t in ths:
    t.join()

report = {"elapsed_s": round(time.time() - T0), "source_commit": open(f"{SRC}/COMMIT.txt").read().strip(), "models": {}}
for n in MODELS:
    probe = json.load(open(f"{OUT}/probe-{n}.json")) if os.path.exists(f"{OUT}/probe-{n}.json") else {}
    logp = f"{OUT}/train-{n}/train-log.jsonl"
    recs = [json.loads(l) for l in open(logp)] if os.path.exists(logp) else []
    cfgp = f"{OUT}/train-{n}/config.json"
    cfg = json.load(open(cfgp)) if os.path.exists(cfgp) else {}
    tl = open(f"{OUT}/train-{n}.log").read()
    losses = [r["loss"] for r in recs if r.get("loss") is not None]
    mem = max([r.get("max_mem_gb", 0) for r in recs] or [0])
    m = {**runs.get(n, {}), "probe": probe, "train_steps_logged": len(recs), "losses": losses,
         "peak_mem_gib": mem, "tok_s": recs[-1]["tok_s"] if recs else None, "nonfinite": recs[-1].get("nonfinite") if recs else None,
         "oom_in_log": "out of memory" in tl, "trainable_params": cfg.get("trainable_params"),
         "train_examples": cfg.get("train_examples"), "train_ids_sha256": cfg.get("train_ids_sha256")}
    m["gate"] = {"template_parity": bool(probe.get("template_parity")), "finite": bool(probe.get("finite")) and all(l == l for l in losses) and bool(losses),
                 "activation_headroom": bool(probe.get("max_abs_activation_fp16", 1e9) < 30000), "no_skips": m["nonfinite"] == 0 and not m["oom_in_log"],
                 "memory": 0 < mem < 14.5}
    m["passed"] = all(m["gate"].values())
    report["models"][n] = m
    print(n, json.dumps({k: m[k] for k in ("passed", "gate", "peak_mem_gib", "tok_s", "losses", "trainable_params")}), flush=True)
json.dump(report, open(f"{OUT}/report.json", "w"), indent=1)
for n in MODELS:
    shutil.rmtree(f"{OUT}/train-{n}/ckpt", ignore_errors=True)   # keep logs, not the smoke adapters
