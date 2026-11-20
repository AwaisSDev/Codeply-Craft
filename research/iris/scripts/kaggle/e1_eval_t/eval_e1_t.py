"""E1 re-run of the five crashed Transformers cells only (owner decision 2026-11-20). Validation only.

Same cells, prompts, decoding, scoring, artifacts and runner (`e1_run.py`) as E1-PROTOCOL; the one setup fix is the
historical kernel's own step: `pip uninstall -y torchao` (the Kaggle image's torchao 0.10.0 makes peft 0.21.3 refuse
to build LoRA layers; E1-RESULTS §2). Recorded deviations: E1-RERUN.md.

Mode is chosen by the hardware:
  * no GPU  -> PREFLIGHT ONLY (CPU kernel, no GPU quota): G0 hashes, torchao removal, imports, every adapter loaded,
               merged and generating 4 tokens, TG2 (the T-path prompt string vs the official template). Then exit.
  * 2 x T4  -> the same preflight first (stop on any failure, no other setup tried), then SC1 and the cells:
               GPU0: SC1 -> cell 1 (r2 T open, G2 gate) -> cell 13 (r2 T closed)
               GPU1: (after SC1) cell 6 (pilot T open) -> cell 15 (pilot T closed)
               cell 11 (r3 T open) on whichever GPU frees first.
               G2 failure kills every running Transformers cell and starts no more (the protocol's stop).
Hard limit: CAP seconds of kernel time (the remaining approved GPU budget minus start-up margin); at CAP no cell starts
and running cells are killed and reported incomplete.
Outputs: /kaggle/working/results/foundation-2026-11/e1/{r2-T,p-T,r3-T}/, /kaggle/working/e1t-status.json, logs/.
"""
import glob, hashlib, json, os, shutil, signal, subprocess, sys, threading, time
T0 = time.time()
CAP = 6100            # remaining approved budget: 3.5 h - 6,197 s used by E1 v1 = 6,403 s; ~5 min start-up margin
W = "/kaggle/working"
ST = {"checks": {}, "cells": {}, "deviations": [], "stopped": {}}
LOCK = threading.Lock()
PROCS = set()
STOP = threading.Event()


def save():
    with LOCK:
        ST["elapsed_s"] = round(time.time() - T0)
        json.dump(ST, open(f"{W}/e1t-status.json", "w"), indent=1)


def log(*a):
    print(f"[{time.time() - T0:7.0f}s]", *a, flush=True)


def stop(check, why):
    ST["checks"][check] = {"pass": False, "why": why}
    ST["result"] = "PREFLIGHT FAILED: stopped, nothing run"
    save()
    raise SystemExit(f"STOP {check}: {why}")


def ok(check, **kw):
    ST["checks"][check] = {"pass": True, **kw}
    save()
    log("PASS", check)


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def find(pattern):
    hits = sorted(glob.glob(pattern, recursive=True))
    return hits[0] if hits else None


def sh(cmd, check=True):
    log("+", cmd[:200])
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode and check:
        print(r.stdout[-2000:], r.stderr[-2000:], flush=True)
        stop("setup", f"command failed: {cmd[:160]}")
    return r


# source, G0 ---------------------------------------------------------------------------------------------------------
init = find("/kaggle/input/**/codeply_iris/__init__.py")
if not init:
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    init = find(f"{W}/src/**/codeply_iris/__init__.py")
SRC = "/tmp/iris"
shutil.copytree(os.path.dirname(os.path.dirname(init)), SRC, dirs_exist_ok=True)
if os.path.exists(f"{SRC}/data/raw/test") or os.path.exists(f"{SRC}/data/built/test.jsonl"):
    stop("G0_no_test", "test split present")
E1 = f"{SRC}/foundation-2026-11/next-phase/e1"
EXP = json.load(open(f"{E1}/e1_expected.json"))
ST["source_commit"] = open(f"{SRC}/COMMIT.txt").read().strip()
ADP = {"r2": find("/kaggle/input/**/iris-1.7b-r2/adapter_model.safetensors"),
       "r3": find("/kaggle/input/**/iris-1.7b-r3/adapter_model.safetensors"),
       "pilot": find("/kaggle/input/**/runs/pilot-qwen3-1.7b-s1/best/adapter/adapter_model.safetensors")}
ADIR = {}
for k, p in ADP.items():
    if not p or sha256(p) != EXP["adapters"][k]["sha256"]:
        stop(f"G0_adapter_{k}", "missing or sha256 mismatch")
    ADIR[k] = f"/tmp/adapter-{k}"
    shutil.copytree(os.path.dirname(p), ADIR[k], dirs_exist_ok=True)
ok("G0_adapters")
for rel, h in EXP["val"].items():
    if sha256(f"{SRC}/{rel}") != h:
        stop("G0_val", rel)
ok("G0_val")
smi = subprocess.run("nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True)
GPU = smi.returncode == 0 and smi.stdout.count("T4") >= 2
ST["mode"] = "gpu" if GPU else "preflight-only (cpu)"
ST["gpus"] = smi.stdout.strip()
save()

# environment: the historical step, then the pins ----------------------------------------------------------------------
tv = sh(f"{sys.executable} -c \"import importlib.util as u; m=u.find_spec('torchao'); print(__import__('torchao').__version__ if m else 'absent')\"", check=False)
ST["torchao_before"] = (tv.stdout.strip() or tv.stderr.strip()[-200:])
sh(f"{sys.executable} -m pip -q uninstall -y torchao", check=False)
pins = EXP["env_pins"]
sh(f"{sys.executable} -m pip install -q transformers=={pins['transformers']} peft=={pins['peft']} accelerate=={pins['accelerate']} sentencepiece protobuf")
v = sh(f"{sys.executable} -c \"import importlib.util as u, torch, transformers, peft, accelerate; print(torch.__version__, transformers.__version__, peft.__version__, accelerate.__version__, 'absent' if u.find_spec('torchao') is None else 'present')\"").stdout.split()
ST["env"] = dict(zip(("torch", "transformers", "peft", "accelerate", "torchao_after"), v))
if ST["env"]["torchao_after"] != "absent":
    stop("env_torchao", "torchao still importable after uninstall")
for k in ("transformers", "peft"):
    if ST["env"][k] != pins[k]:
        stop("env_pins", f"{k} {ST['env'][k]} != {pins[k]}")
ok("env", **ST["env"])

os.environ["HF_HOME"] = "/tmp/hf"
from huggingface_hub import snapshot_download  # noqa: E402
BASE = snapshot_download(EXP["base"]["repo"], revision=EXP["base"]["revision"])
for rel, h in EXP["base"]["files"].items():
    p = f"{BASE}/{rel}"
    d = open(p, "rb").read() if os.path.exists(p) else None
    got = None if d is None else (hashlib.sha256(d).hexdigest() if "sha256" in h else hashlib.sha1(b"blob %d\0" % len(d) + d).hexdigest())
    if got != (h.get("sha256") or h.get("git_blob_sha1")):
        stop("G0_base", rel)
ok("G0_base", revision=EXP["base"]["revision"])

# preflight: imports + adapter loading (GPU0 when present), TG2 (T path) ----------------------------------------------
env = dict(os.environ, PYTHONUNBUFFERED="1")
r = subprocess.run([sys.executable, f"{E1}/adapter_check.py", BASE] + [f"{k}={v}" for k, v in ADIR.items()], cwd=SRC,
                   env=dict(env, CUDA_VISIBLE_DEVICES="0" if GPU else ""), capture_output=True, text=True)
line = next((l for l in r.stdout.splitlines() if l.startswith("{")), None)
res = json.loads(line) if line else {"pass": False, "stderr": r.stderr[-1500:]}
ST["checks"]["preflight_adapters"] = res
save()
if not res.get("pass"):
    stop("preflight_adapters", "adapter loading failed")
log("PASS preflight_adapters")
TG2 = f'''
import json, sys
sys.path.insert(0, "{E1}"); sys.path.insert(0, "{SRC}")
from transformers import AutoTokenizer
import e1_gates as G
from codeply_iris import prompt
tok = AutoTokenizer.from_pretrained("{BASE}")
cs = G.cases()
same = [tok.apply_chat_template(prompt.chat_messages(u, prompt.SYSTEM), tokenize=False, add_generation_prompt=True, enable_thinking=False)
        == prompt.chatml(u, prompt.SYSTEM) + G.THINK_OFF for _, u in cs]
print(json.dumps({{"TG2_T_path_matches": sum(same), "n": len(same)}}))
'''
r = subprocess.run([sys.executable, "-c", TG2], cwd=SRC, env=env, capture_output=True, text=True)
line = next((l for l in r.stdout.splitlines() if l.startswith("{")), None)
tg = json.loads(line) if line else {}
if not tg or tg["TG2_T_path_matches"] != tg["n"]:
    stop("preflight_TG2", json.dumps(tg) or r.stderr[-800:])
ok("preflight_TG2", **tg)
if not GPU:
    ST["result"] = "PREFLIGHT PASSED (cpu mode): no cell run"
    save()
    log("preflight-only mode: done")
    sys.exit(0)

# cells -------------------------------------------------------------------------------------------------------------
RES = f"{W}/results/foundation-2026-11/e1"
os.makedirs(RES, exist_ok=True)
os.makedirs(f"{W}/logs", exist_ok=True)


def over():
    return time.time() - T0 > CAP


def run_proc(cmd, gpu, logf):
    p = subprocess.Popen(cmd, shell=True, cwd=SRC, env=dict(env, CUDA_VISIBLE_DEVICES=str(gpu)), stdout=open(logf, "a"),
                         stderr=subprocess.STDOUT, start_new_session=True)
    with LOCK:
        PROCS.add(p)
    why = None
    while p.poll() is None:
        if over() or STOP.is_set():
            why = "killed_at_cap" if over() else "killed_G2_stop"
            os.killpg(p.pid, signal.SIGTERM)
            time.sleep(10)
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            break
        time.sleep(5)
    with LOCK:
        PROCS.discard(p)
    return why or p.returncode


def check_result(out, loop):
    p = f"{out}/result-val-{loop}.json"
    if not os.path.exists(p):
        return None
    m = json.load(open(p))["metrics"]
    return {"complete": m.get("n_sessions") == 120 and (loop == "closed" or m.get("n_queries") == 64),
            "f1": m.get("extraction_f1"), "validity": m.get("output_validity"), "false_per_100": m.get("false_memories_per_100_sessions")}


def cell(cid, name, gpu, adapter, prefix, loop, capture):
    key = f"{cid}:{name}:{loop}"
    if over() or STOP.is_set():
        with LOCK:
            ST["cells"][key] = {"status": "not_started_cap" if over() else "not_started_G2_stop"}
        save()
        return None
    out = f"{RES}/{name}"
    os.makedirs(out, exist_ok=True)
    t = time.time()
    cmd = (f"{sys.executable} {E1}/e1_run.py --base {BASE} --adapter {ADIR[adapter]} --prefix {prefix} --out {out} --label {name}"
           + (" --closed-loop" if loop == "closed" else "") + ("" if capture else " --no-capture"))
    log(f"gpu{gpu} start {key}")
    rc = run_proc(cmd, gpu, f"{W}/logs/{name}-{loop}.log")
    res = check_result(out, loop)
    status = "ok" if rc == 0 and res and res["complete"] else (rc if isinstance(rc, str) else "failed")
    if status == "ok":
        subprocess.run(f"{sys.executable} foundation-2026-11/report_run.py {out}", shell=True, cwd=SRC, env=env,
                       stdout=open(f"{W}/logs/{name}-{loop}.log", "a"), stderr=subprocess.STDOUT)
    rec = {"status": status, "exit": rc, "gpu": gpu, "minutes": round((time.time() - t) / 60, 1), "result": res,
           "cmd": cmd.replace(SRC, "<src>")}
    with LOCK:
        ST["cells"][key] = rec
    save()
    log(f"gpu{gpu} end {key}", status, res)
    return rec


SC1 = threading.Event()
CAPTURE = {"on": True}
R3 = {"taken": False}


def take_r3():
    with LOCK:
        if R3["taken"]:
            return False
        R3["taken"] = True
        return True


def gpu0():
    r = subprocess.run(f"{sys.executable} {E1}/e1_run.py --base {BASE} --adapter {ADIR['r2']} --prefix none --sc1 {W}/sc1.json",
                       shell=True, cwd=SRC, env=dict(env, CUDA_VISIBLE_DEVICES="0"), capture_output=True, text=True)
    s = json.load(open(f"{W}/sc1.json")) if os.path.exists(f"{W}/sc1.json") else {"SC1_pass": False, "error": r.stderr[-800:]}
    CAPTURE["on"] = bool(s.get("SC1_pass"))
    with LOCK:
        ST["checks"]["SC1"] = {"pass": CAPTURE["on"], **{k: s.get(k) for k in ("identical", "n", "align_fail", "seconds", "versions", "error")}}
        if not CAPTURE["on"]:
            ST["deviations"].append("SC1 failed: Transformers cells run without log-probability capture (P@60 N/A there)")
    save()
    SC1.set()
    c1 = cell(1, "r2-T", 0, "r2", "none", "open", CAPTURE["on"])
    ref = EXP["reference_results"]["r2_open"]
    g2 = bool(c1 and c1["result"] and abs(c1["result"]["f1"] - ref["f1"]) <= 0.02 and abs(c1["result"]["validity"] - ref["validity"]) <= 0.03)
    with LOCK:
        ST["checks"]["G2"] = {"pass": g2, "observed": c1 and c1["result"], "reference": ref,
                              "classification": "reproduction of the historical number with the same base content (revision not recorded)"}
    save()
    if not g2:
        with LOCK:
            ST["stopped"]["all"] = "G2 failed: every Transformers cell stopped (running cells killed)"
        STOP.set()
        save()
        return
    cell(13, "r2-T", 0, "r2", "none", "closed", CAPTURE["on"])
    if take_r3():
        cell(11, "r3-T", 0, "r3", "none", "open", CAPTURE["on"])


def gpu1():
    SC1.wait()
    cell(6, "p-T", 1, "pilot", "think", "open", CAPTURE["on"])
    cell(15, "p-T", 1, "pilot", "think", "closed", CAPTURE["on"])
    if take_r3():
        cell(11, "r3-T", 1, "r3", "none", "open", CAPTURE["on"])


th = [threading.Thread(target=f) for f in (gpu0, gpu1)]
for t in th:
    t.start()
while any(t.is_alive() for t in th):
    time.sleep(120)
    log("running; ok cells:", sum(1 for c in ST["cells"].values() if c.get("status") == "ok"))
ST["hard_cap_reached"] = over()
ST["result"] = "cells finished"
save()
log("done", json.dumps({k: v.get("status") for k, v in ST["cells"].items()}))
