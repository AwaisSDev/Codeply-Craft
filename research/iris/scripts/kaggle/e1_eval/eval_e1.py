"""E1 GPU evaluation (E1-PROTOCOL §2-§6). Validation only; nothing is trained; no model is selected.

Inputs:  dataset codeply-iris-e1-src (code + val only + E1 scripts); dataset codeply-iris-adapters-v1 (r2 / r3);
         kernel outputs codeply-iris-pilot-train (pilot adapter), codeply-iris-e1-export (GGUFs + export-status.json,
         which must report every check passed), codeply-iris-wave-a-check (CUDA llama.cpp at the pinned commit).
Work:    re-verify every hash (G0), base at the pinned revision (file hashes), versions; template gates (G1, CPU);
         SC1 on GPU0; then two queues, one per T4, in the protocol's order:
           GPU0: cells 1 (G2 gate) -> 6 -> 13 -> 15 -> 11      (Transformers fp16, e1_run.py)
           GPU1: cell 10 (G3 check) -> 2-5 -> 7-9 -> 12 -> 14 -> 16 -> X1 -> X2   (llama-server, -ngl 99)
Stops:   hard cap 3 h 25 min of kernel time (the 3.5 GPU-hour stop, minus startup): no cell is started after it and
         running cells are killed (their partial caches stay; they are reported incomplete). A failed cell is
         reported, never re-run with other settings.
Outputs: /kaggle/working/results/foundation-2026-11/e1/<cell>/ and /kaggle/working/e1-status.json.
"""
import glob, hashlib, json, os, shutil, signal, socket, subprocess, sys, threading, time, urllib.request
T0 = time.time()
CAP = 3 * 3600 + 25 * 60
W = "/kaggle/working"
OFF = '{"enable_thinking": false}'
ST = {"checks": {}, "cells": {}, "deviations": [], "stopped": {}}
LOCK = threading.Lock()
PROCS = set()


def save():
    with LOCK:
        ST["elapsed_s"] = round(time.time() - T0)
        json.dump(ST, open(f"{W}/e1-status.json", "w"), indent=1)


def log(*a):
    print(f"[{time.time() - T0:7.0f}s]", *a, flush=True)


def stop(check, why):
    ST["checks"][check] = {"pass": False, "why": why}
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


def sh(cmd):
    log("+", cmd[:200])
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode:
        print(r.stdout[-2000:], r.stderr[-2000:], flush=True)
        stop("setup", f"command failed: {cmd[:160]}")
    return r.stdout


# source, export status ------------------------------------------------------------------------------------------
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
xs = find("/kaggle/input/**/export-status.json")
if not xs:
    stop("export_status", "export-status.json missing")
XS = json.load(open(xs))
if not XS.get("all_checks_pass"):
    stop("export_status", "the CPU export did not pass all checks")
ST["export"] = {"source_commit": XS.get("source_commit"), "deviations": XS.get("deviations")}
ok("export_status")

# G0 -------------------------------------------------------------------------------------------------------------
ADP = {"r2": find("/kaggle/input/**/iris-1.7b-r2/adapter_model.safetensors"),
       "r3": find("/kaggle/input/**/iris-1.7b-r3/adapter_model.safetensors"),
       "pilot": find("/kaggle/input/**/runs/pilot-qwen3-1.7b-s1/best/adapter/adapter_model.safetensors")}
for k, p in ADP.items():
    if not p or sha256(p) != EXP["adapters"][k]["sha256"]:
        stop(f"G0_adapter_{k}", "missing or sha256 mismatch")
ADIR = {}
for k, p in ADP.items():                                   # peft wants a writable-looking normal dir; copy it
    ADIR[k] = f"/tmp/adapter-{k}"
    shutil.copytree(os.path.dirname(p), ADIR[k], dirs_exist_ok=True)
ok("G0_adapters")
GD = os.path.dirname(find("/kaggle/input/**/gguf/e1-r2-F16.gguf") or "/missing/x")
GG = {"r2-F16": "e1-r2-F16.gguf", "r2-Q4": "e1-r2-Q4_K_M.gguf", "r3-Q4": "e1-r3-Q4_K_M.gguf", "p-F16": "e1-pilot-F16.gguf",
      "p-Q4": "qwen3-1.7b-pilot-s1-Q4_K_M.gguf"}
want = dict(reversed(l.split()) for l in open(f"{GD}/SHA256SUMS")) if os.path.exists(f"{GD}/SHA256SUMS") else {}
for k, f in GG.items():
    p = f"{GD}/{f}"
    if not os.path.exists(p) or f not in want or sha256(p) != want[f]:
        stop(f"G0_gguf_{k}", "missing or sha256 mismatch")
if want.get(GG["p-Q4"]) != EXP["gguf"]["pilot_q4_original"]["sha256"]:
    stop("G0_gguf_p-Q4", "not the seed-1 GGUF")
ok("G0_gguf", files=want)
for rel, h in EXP["val"].items():
    if sha256(f"{SRC}/{rel}") != h:
        stop("G0_val", rel)
ok("G0_val")

B = f"{W}/llama-bin"
shutil.copytree(os.path.dirname(find("/kaggle/input/**/llama-bin/llama-server")), B, dirs_exist_ok=True)
subprocess.run(f"chmod +x {B}/llama-server", shell=True, check=True)
for _ in range(3):                                          # Kaggle drops versioned .so symlinks: recreate them
    out = subprocess.run(f"LD_LIBRARY_PATH={B} ldd {B}/llama-server", shell=True, capture_output=True, text=True).stdout
    missing = [l.split()[0] for l in out.splitlines() if "not found" in l]
    if not missing:
        break
    for name in missing:
        c = sorted(f for f in os.listdir(B) if f.startswith(name.split(".so")[0] + ".so") and f != name)
        if c:
            os.symlink(c[-1], os.path.join(B, name))
ver = subprocess.run(f"LD_LIBRARY_PATH={B} {B}/llama-server --version", shell=True, capture_output=True, text=True)
ver = (ver.stdout + ver.stderr).strip()
if EXP["llama_cpp_commit"][:7] not in ver:
    stop("G0_llama_commit", ver[-200:])
ok("G0_llama_commit", version=ver[-120:])

smi = subprocess.run("nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True)
if smi.returncode or smi.stdout.count("T4") < 2:
    stop("G0_gpus", smi.stdout.strip() or "no GPU")
ok("G0_gpus", gpus=smi.stdout.strip())

pins = EXP["env_pins"]
sh(f"{sys.executable} -m pip install -q transformers=={pins['transformers']} peft=={pins['peft']} accelerate=={pins['accelerate']} sentencepiece protobuf")
v = sh(f"{sys.executable} -c \"import torch, transformers, peft, accelerate; print(torch.__version__, transformers.__version__, peft.__version__, accelerate.__version__)\"").split()
ST["env"] = dict(zip(("torch", "transformers", "peft", "accelerate"), v))
for k, want_v in (("transformers", pins["transformers"]), ("peft", pins["peft"])):
    if ST["env"][k] != want_v:
        ST["deviations"].append(f"{k} {ST['env'][k]} instead of {want_v}")
if ST["env"]["torch"] != pins["historical_r2_r3"]["torch"]:
    ST["deviations"].append(f"torch {ST['env']['torch']} (historical r2 / r3 evaluation: {pins['historical_r2_r3']['torch']})")
save()

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

# G1: template gates (CPU, -ngl 0) ---------------------------------------------------------------------------------
env = dict(os.environ, IRIS_LLAMA_SERVER=f"{B}/llama-server", LD_LIBRARY_PATH=B + ":" + os.environ.get("LD_LIBRARY_PATH", ""),
           PYTHONUNBUFFERED="1")
r = subprocess.run([sys.executable, f"{E1}/e1_gates.py", "--tokenizer", BASE, "--gguf-r2", f"{GD}/{GG['r2-Q4']}",
                    "--gguf-pilot", f"{GD}/{GG['p-Q4']}", "--out", f"{W}/gates.json"], cwd=SRC, env=dict(env, CUDA_VISIBLE_DEVICES="1"),
                   capture_output=True, text=True)
g = json.load(open(f"{W}/gates.json")) if os.path.exists(f"{W}/gates.json") else {}
if not g:
    print(r.stdout[-2000:], r.stderr[-3000:], flush=True)
    stop("G1", "gate script did not complete (infrastructure failure, not a template result)")
TG1, TG2 = bool(g.get("TG1_pass")), bool(g.get("TG2_pass"))
ST["checks"]["G1_TG1"] = {"pass": TG1, "matches": g.get("TG1_matches"), "n": g.get("n"), "stderr": r.stderr[-500:] if not g else ""}
ST["checks"]["G1_TG2"] = {"pass": TG2, "hf": g.get("TG2_hf_matches"), "server": g.get("TG2_server_matches"), "n": g.get("n")}
ST["checks"]["TOK"] = {"r2": g.get("TOK_r2_matches"), "pilot": g.get("TOK_pilot_matches")}
if not TG1:
    ST["deviations"].append("TG1 failed: r2 / r3 GGUF cells use the pre-declared raw /completion fallback (no logprobs, P@60 N/A)")
if not TG2:
    ST["deviations"].append("TG2 failed: pilot Transformers cells 6 and 15 are not run")
save()

# cells --------------------------------------------------------------------------------------------------------------
RES = f"{W}/results/foundation-2026-11/e1"
os.makedirs(RES, exist_ok=True)
TMPL = f"{E1}/chatml_raw.jinja"


def over():
    return time.time() - T0 > CAP


def run_proc(cmd, gpu, logf):
    p = subprocess.Popen(cmd, shell=True, cwd=SRC, env=dict(env, CUDA_VISIBLE_DEVICES=str(gpu)), stdout=open(logf, "a"),
                         stderr=subprocess.STDOUT, start_new_session=True)
    with LOCK:
        PROCS.add(p)
    while p.poll() is None:
        if over():
            os.killpg(p.pid, signal.SIGTERM)
            time.sleep(10)
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            with LOCK:
                PROCS.discard(p)
            return "killed_at_cap"
        time.sleep(5)
    with LOCK:
        PROCS.discard(p)
    return p.returncode


class RawServer:
    """TG1 fallback only: llama-server on the GPU for the raw /completion path (ServerBackend(url=...))."""
    def __init__(self, gguf, gpu):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0)); self.port = s.getsockname()[1]
        self.p = subprocess.Popen([f"{B}/llama-server", "-m", gguf, "--host", "127.0.0.1", "--port", str(self.port), "-c", "8192",
                                   "--parallel", "1", "--no-webui", "-t", "4", "-ngl", "99"], env=dict(env, CUDA_VISIBLE_DEVICES=str(gpu)),
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        t = time.time()
        while time.time() - t < 300:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as r:
                    if r.status == 200:
                        return
            except Exception:
                time.sleep(1)
        raise RuntimeError("raw server not healthy")


def check_result(out, loop):
    p = f"{out}/result-val-{loop}.json"
    if not os.path.exists(p):
        return None
    m = json.load(open(p))["metrics"]
    complete = m.get("n_sessions") == 120 and (loop == "closed" or m.get("n_queries") == 64)
    return {"complete": complete, "f1": m.get("extraction_f1"), "validity": m.get("output_validity"),
            "false_per_100": m.get("false_memories_per_100_sessions")}


def cell(cid, name, kind, gpu, loop="open", adapter=None, prefix=None, gguf=None, fmt=None, constrain=False, capture=True):
    out = f"{RES}/{name}"
    os.makedirs(out, exist_ok=True)
    key = f"{cid}:{name}:{loop}"
    if over():
        ST["cells"][key] = {"status": "not_started_cap"}
        save()
        return None
    t = time.time()
    logf = f"{W}/logs/{name}-{loop}.log"
    os.makedirs(f"{W}/logs", exist_ok=True)
    srv = None
    if kind == "T":
        cmd = (f"{sys.executable} {E1}/e1_run.py --base {BASE} --adapter {ADIR[adapter]} --prefix {prefix} --out {out} --label {name}"
               + (" --closed-loop" if loop == "closed" else "") + ("" if capture else " --no-capture"))
    else:
        base = f"{sys.executable} -m codeply_iris.evaluate --system iris --split val --out {out} --label {name} --threads 4"
        if fmt == "raw" and not TG1:
            srv = RawServer(f"{GD}/{GG[gguf]}", gpu)
            cmd = f"{base} --model http://127.0.0.1:{srv.port}"
        else:
            cmd = f"{base} --model {GD}/{GG[gguf]} --chat --server-arg=-ngl --server-arg=99"
            if fmt == "raw":
                cmd += f" --server-arg=--chat-template-file --server-arg={TMPL}"
            else:
                cmd += f" --template-kwargs '{OFF}'"
        cmd += (" --constrain" if constrain else "") + (" --closed-loop" if loop == "closed" else "")
    log(f"gpu{gpu} start {key}")
    rc = run_proc(cmd, gpu, logf)
    if srv:
        srv.p.terminate()
    res = check_result(out, loop)
    status = "ok" if rc == 0 and res and res["complete"] else ("killed_at_cap" if rc == "killed_at_cap" else "failed")
    if status == "ok":
        subprocess.run(f"{sys.executable} foundation-2026-11/report_run.py {out}", shell=True, cwd=SRC, env=env,
                       stdout=open(logf, "a"), stderr=subprocess.STDOUT)
    rec = {"status": status, "exit": rc, "minutes": round((time.time() - t) / 60, 1), "result": res, "cmd": cmd.replace(SRC, "<src>")}
    if fmt == "raw" and kind != "T" and not TG1:
        rec["fallback"] = "raw /completion path (TG1 failed)"
    with LOCK:
        ST["cells"][key] = rec
    save()
    log(f"gpu{gpu} end {key}", status, res)
    return rec


SC1 = {"pass": None}


def gpu0():
    r = subprocess.run(f"{sys.executable} {E1}/e1_run.py --base {BASE} --adapter {ADIR['r2']} --prefix none --sc1 {W}/sc1.json",
                       shell=True, cwd=SRC, env=dict(env, CUDA_VISIBLE_DEVICES="0"), capture_output=True, text=True)
    s = json.load(open(f"{W}/sc1.json")) if os.path.exists(f"{W}/sc1.json") else {"SC1_pass": False, "error": r.stderr[-800:]}
    SC1["pass"] = bool(s.get("SC1_pass"))
    with LOCK:
        ST["checks"]["SC1"] = {"pass": SC1["pass"], **{k: s.get(k) for k in ("identical", "n", "align_fail", "seconds", "versions", "error")}}
        if not SC1["pass"]:
            ST["deviations"].append("SC1 failed: Transformers cells run without log-probability capture (P@60 N/A there)")
    save()
    cap = SC1["pass"]
    c1 = cell(1, "r2-T", "T", 0, adapter="r2", prefix="none", capture=cap)
    ref = EXP["reference_results"]["r2_open"]
    g2 = bool(c1 and c1["result"] and abs(c1["result"]["f1"] - ref["f1"]) <= 0.02 and abs(c1["result"]["validity"] - ref["validity"]) <= 0.03)
    with LOCK:
        ST["checks"]["G2"] = {"pass": g2, "observed": c1 and c1["result"], "reference": ref}
    save()
    if not g2:
        with LOCK:
            ST["stopped"]["gpu0"] = "G2 failed: all Transformers cells stopped after cell 1"
        save()
        return
    if TG2:
        cell(6, "p-T", "T", 0, adapter="pilot", prefix="think", capture=cap)
    cell(13, "r2-T", "T", 0, loop="closed", adapter="r2", prefix="none", capture=cap)
    if TG2:
        cell(15, "p-T", "T", 0, loop="closed", adapter="pilot", prefix="think", capture=cap)
    cell(11, "r3-T", "T", 0, adapter="r3", prefix="none", capture=cap)


def gpu1():
    c10 = cell(10, "p-Q4C", "G", 1, gguf="p-Q4", fmt="think", constrain=True)
    ref = EXP["reference_results"]["pilot_q4c_open"]
    g3 = bool(c10 and c10["result"] and abs(c10["result"]["f1"] - ref["f1"]) <= 0.02)
    with LOCK:
        ST["checks"]["G3"] = {"pass": g3, "observed": c10 and c10["result"], "reference": ref, "action": "report only"}
    save()
    cell(2, "r2-F16U", "G", 1, gguf="r2-F16", fmt="raw")
    cell(3, "r2-F16C", "G", 1, gguf="r2-F16", fmt="raw", constrain=True)
    cell(4, "r2-Q4U", "G", 1, gguf="r2-Q4", fmt="raw")
    cell(5, "r2-Q4C", "G", 1, gguf="r2-Q4", fmt="raw", constrain=True)
    cell(7, "p-F16U", "G", 1, gguf="p-F16", fmt="think")
    cell(8, "p-F16C", "G", 1, gguf="p-F16", fmt="think", constrain=True)
    cell(9, "p-Q4U", "G", 1, gguf="p-Q4", fmt="think")
    cell(12, "r3-Q4C", "G", 1, gguf="r3-Q4", fmt="raw", constrain=True)
    cell(14, "r2-Q4C", "G", 1, loop="closed", gguf="r2-Q4", fmt="raw", constrain=True)
    cell(16, "p-Q4C", "G", 1, loop="closed", gguf="p-Q4", fmt="think", constrain=True)
    cell("X1", "X1-p-Q4C-nothink", "G", 1, gguf="p-Q4", fmt="raw", constrain=True)
    cell("X2", "X2-r2-Q4C-think", "G", 1, gguf="r2-Q4", fmt="think", constrain=True)


th = [threading.Thread(target=f) for f in (gpu0, gpu1)]
for t in th:
    t.start()
while any(t.is_alive() for t in th):
    time.sleep(300)
    log("running; cells done:", sum(1 for c in ST["cells"].values() if c.get("status") == "ok"))
ST["hard_cap_reached"] = over()
save()
log("done", json.dumps({k: v.get("status") for k, v in ST["cells"].items()}))
