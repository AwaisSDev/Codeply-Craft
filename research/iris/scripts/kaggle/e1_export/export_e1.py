"""E1 export + integrity checks on a CPU-only Kaggle kernel (no GPU quota). E1-PROTOCOL §1, §6 (G0, G1).

Inputs:  dataset codeply-iris-e1-src (code, val split only, E1 scripts, e1_expected.json); dataset
         codeply-iris-adapters-v1 (r2 / r3); kernel outputs codeply-iris-pilot-train (pilot adapter) and
         codeply-iris-pilot-export (the seed-1 pilot Q4 GGUF).
Steps:   G0 verify every adapter and the pilot Q4 sha256, the val data, the raw ChatML template; download the base at
         the pinned revision and verify every file (LFS sha256 / git blob sha1) against the recorded HF tree; build
         llama.cpp at the pinned commit (quantize + server, CPU); for r2, r3, pilot: streaming fp32 merge saved fp16 (same
         procedure as the pilot export) -> convert_hf_to_gguf f16 -> llama-quantize Q4_K_M. Keep F16 for r2 and pilot,
         Q4 for r2 and r3; the pilot re-export Q4 is hashed and compared with the original, then deleted (check only).
         G1: e1_gates.py (TG1 / TG2 / token ids) on the exported r2 Q4 and the original pilot Q4.
Output:  /kaggle/working/gguf/*.gguf, SHA256SUMS, export-status.json (every check, pass / fail, with reasons).
A failed G0 check stops the kernel before any export; nothing is substituted.
"""
import glob, hashlib, json, os, shutil, subprocess, sys, time
T0 = time.time()
W = "/kaggle/working"
STATUS = {"checks": {}, "artifacts": {}, "deviations": []}


def save():
    STATUS["elapsed_s"] = round(time.time() - T0)
    json.dump(STATUS, open(f"{W}/export-status.json", "w"), indent=1)


def log(*a):
    print(f"[{time.time() - T0:6.0f}s]", *a, flush=True)


def sh(cmd, check=True):
    log("+", cmd[:220])
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode and check:
        print(r.stdout[-3000:], r.stderr[-3000:], flush=True)
        STATUS["failed_command"] = cmd[:300]
        save()
        raise SystemExit(f"failed: {cmd[:160]}")
    return r


def fail(check, why):
    STATUS["checks"][check] = {"pass": False, "why": why}
    save()
    raise SystemExit(f"STOP {check}: {why}")


def ok(check, **kw):
    STATUS["checks"][check] = {"pass": True, **kw}
    save()
    log("PASS", check, kw if len(str(kw)) < 300 else "")


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def git_blob(p):
    d = open(p, "rb").read()
    return hashlib.sha1(b"blob %d\0" % len(d) + d).hexdigest()


def find(pattern):
    hits = sorted(glob.glob(pattern, recursive=True))
    return hits[0] if hits else None


# source ------------------------------------------------------------------------------------------------------------
init = find("/kaggle/input/**/codeply_iris/__init__.py")
if not init:
    for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
        shutil.unpack_archive(z, f"{W}/src")
    init = find(f"{W}/src/**/codeply_iris/__init__.py")
SRC = "/tmp/iris"
shutil.copytree(os.path.dirname(os.path.dirname(init)), SRC, dirs_exist_ok=True)
E1 = f"{SRC}/foundation-2026-11/next-phase/e1"
EXP = json.load(open(f"{E1}/e1_expected.json"))
STATUS["source_commit"] = open(f"{SRC}/COMMIT.txt").read().strip()
if os.path.exists(f"{SRC}/data/raw/test") or os.path.exists(f"{SRC}/data/built/test.jsonl"):
    fail("G0_no_test", "test split present in the source dataset")
ok("G0_no_test")

# G0: adapters, pilot Q4, val, template ------------------------------------------------------------------------------
ADP = {"r2": find("/kaggle/input/**/iris-1.7b-r2/adapter_model.safetensors"),
       "r3": find("/kaggle/input/**/iris-1.7b-r3/adapter_model.safetensors"),
       "pilot": find("/kaggle/input/**/runs/pilot-qwen3-1.7b-s1/best/adapter/adapter_model.safetensors")}
for k, p in ADP.items():
    if not p:
        fail(f"G0_adapter_{k}", "missing")
    got = sha256(p)
    if got != EXP["adapters"][k]["sha256"]:
        fail(f"G0_adapter_{k}", f"sha256 {got} != {EXP['adapters'][k]['sha256']}")
    if not os.path.exists(os.path.join(os.path.dirname(p), "adapter_config.json")):
        fail(f"G0_adapter_{k}", "adapter_config.json missing")
    ok(f"G0_adapter_{k}", path=p, sha256=got)
PQ4 = find("/kaggle/input/**/gguf/qwen3-1.7b-pilot-s1-Q4_K_M.gguf")
if not PQ4:
    fail("G0_pilot_q4", "missing")
got = sha256(PQ4)
if got != EXP["gguf"]["pilot_q4_original"]["sha256"]:
    fail("G0_pilot_q4", f"sha256 {got}")
ok("G0_pilot_q4", path=PQ4, sha256=got)
for rel, h in EXP["val"].items():
    got = sha256(f"{SRC}/{rel}")
    if got != h:
        fail("G0_val", f"{rel} {got}")
ok("G0_val")
if sha256(f"{E1}/chatml_raw.jinja") != EXP["chat_template_raw_sha256"]:
    fail("G0_template", "chatml_raw.jinja hash")
ok("G0_template")

# environment ---------------------------------------------------------------------------------------------------------
pins = EXP["env_pins"]
sh(f"{sys.executable} -m pip install -q transformers=={pins['transformers']} accelerate=={pins['accelerate']} sentencepiece protobuf")
v = sh(f"{sys.executable} -c \"import torch, transformers, huggingface_hub; print(torch.__version__, transformers.__version__, huggingface_hub.__version__)\"").stdout.split()
STATUS["env"] = {"torch": v[0], "transformers": v[1], "huggingface_hub": v[2], "python": sys.version.split()[0]}
if v[1] != pins["transformers"]:
    STATUS["deviations"].append(f"transformers {v[1]} instead of {pins['transformers']}")

# G0: base at the pinned revision ------------------------------------------------------------------------------------
os.environ["HF_HOME"] = "/tmp/hf"
from huggingface_hub import snapshot_download  # noqa: E402
B = EXP["base"]
BASE = snapshot_download(B["repo"], revision=B["revision"])
bad = {}
for rel, h in B["files"].items():
    p = f"{BASE}/{rel}"
    if not os.path.exists(p):
        bad[rel] = "missing"
        continue
    got = sha256(p) if "sha256" in h else git_blob(p)
    want = h.get("sha256") or h.get("git_blob_sha1")
    if got != want:
        bad[rel] = got
if bad:
    fail("G0_base", json.dumps(bad))
ok("G0_base", revision=B["revision"], files=len(B["files"]))

# llama.cpp at the pinned commit ----------------------------------------------------------------------------------
L = "/tmp/llama"
sh(f"rm -rf {L} && mkdir {L} && cd {L} && git init -q && git remote add origin https://github.com/ggml-org/llama.cpp.git && "
   f"git fetch -q --depth 1 origin {EXP['llama_cpp_commit']} && git checkout -q FETCH_HEAD")
head = sh(f"cd {L} && git rev-parse HEAD").stdout.strip()
if head != EXP["llama_cpp_commit"]:
    fail("G0_llama_commit", head)
sh(f"{sys.executable} -m pip install -q {L}/gguf-py")
sh(f"cd {L} && cmake -S . -B build -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release > /tmp/cmake.log 2>&1 && "
   f"cmake --build build -j{os.cpu_count()} --target llama-quantize llama-server > /tmp/build.log 2>&1")
ver = sh(f"{L}/build/bin/llama-server --version", check=False)
ok("G0_llama_commit", commit=head, server_version=(ver.stdout + ver.stderr).strip()[-200:])

# export ----------------------------------------------------------------------------------------------------------
MERGE = r'''
import glob, json, os, shutil, sys, torch
from safetensors import safe_open
from safetensors.torch import save_file
base, adapter, out = sys.argv[1], sys.argv[2], sys.argv[3]
acfg = json.load(open(f"{adapter}/adapter_config.json"))
scale = acfg["lora_alpha"] / acfg["r"]
lora = {}
with safe_open(f"{adapter}/adapter_model.safetensors", "pt") as f:
    for k in f.keys():
        mod, ab = k.rsplit(".lora_", 1)
        mod = mod[len("base_model.model."):] if mod.startswith("base_model.model.") else mod
        lora.setdefault(mod, {})[ab.split(".")[0]] = f.get_tensor(k).float()
os.makedirs(out, exist_ok=True)
merged = set()
for shard in sorted(glob.glob(f"{base}/*.safetensors")):
    tensors = {}
    with safe_open(shard, "pt") as f:
        for k in f.keys():
            t = f.get_tensor(k)
            mod = k[:-len(".weight")] if k.endswith(".weight") else None
            if mod in lora:
                t = (t.float() + scale * (lora[mod]["B"] @ lora[mod]["A"])).to(torch.float16)
                merged.add(mod)
            elif t.is_floating_point():
                t = t.to(torch.float16)
            tensors[k] = t.contiguous()
    save_file(tensors, f"{out}/{os.path.basename(shard)}", metadata={"format": "pt"})
missing = set(lora) - merged
assert not missing, f"adapter modules not found in the base: {sorted(missing)[:5]}"
for f in glob.glob(f"{base}/*"):
    if not f.endswith(".safetensors") and os.path.isfile(f):
        shutil.copy(f, out)
c = json.load(open(f"{out}/config.json"))
c["torch_dtype"] = c["dtype"] = "float16"
json.dump(c, open(f"{out}/config.json", "w"), indent=2)
print("merged", len(merged), "modules")
'''
open("/tmp/merge.py", "w").write(MERGE)
G = f"{W}/gguf"
os.makedirs(G, exist_ok=True)
PLAN = {"r2": ("keep", "keep"), "r3": ("drop", "keep"), "pilot": ("keep", "check")}
for name, (f16_mode, q4_mode) in PLAN.items():
    t = time.time()
    adapter = os.path.dirname(ADP[name])
    merged, f16 = f"/tmp/merged-{name}", f"/tmp/e1-{name}-F16.gguf"
    q4 = f"/tmp/e1-{name}-Q4_K_M.gguf"
    m = sh(f"{sys.executable} /tmp/merge.py {BASE} {adapter} {merged}").stdout.strip().splitlines()[-1]
    sh(f"{sys.executable} {L}/convert_hf_to_gguf.py {merged} --outtype f16 --outfile {f16}")
    sh(f"{L}/build/bin/llama-quantize {f16} {q4} Q4_K_M")
    rec = {"merge": m, "minutes": None}
    if f16_mode == "keep":
        shutil.move(f16, f"{G}/e1-{name}-F16.gguf")
        rec["F16"] = {"file": f"e1-{name}-F16.gguf", "sha256": sha256(f"{G}/e1-{name}-F16.gguf")}
    else:
        os.remove(f16)
    if q4_mode == "keep":
        shutil.move(q4, f"{G}/e1-{name}-Q4_K_M.gguf")
        rec["Q4_K_M"] = {"file": f"e1-{name}-Q4_K_M.gguf", "sha256": sha256(f"{G}/e1-{name}-Q4_K_M.gguf")}
    else:
        h = sha256(q4)
        rec["Q4_K_M_reexport_check"] = {"sha256": h, "matches_original": h == EXP["gguf"]["pilot_q4_original"]["sha256"]}
        if h != EXP["gguf"]["pilot_q4_original"]["sha256"]:
            STATUS["deviations"].append("pilot Q4 re-export sha256 differs from the seed-1 GGUF; the Q4 cells use the original (G-p-Q4)")
        os.remove(q4)
    shutil.rmtree(merged, ignore_errors=True)
    rec["minutes"] = round((time.time() - t) / 60, 1)
    STATUS["artifacts"][name] = rec
    save()
    log(name, rec)
shutil.copy(PQ4, f"{G}/qwen3-1.7b-pilot-s1-Q4_K_M.gguf")        # the original, carried for the GPU kernel
STATUS["artifacts"]["pilot_q4_original"] = {"file": "qwen3-1.7b-pilot-s1-Q4_K_M.gguf", "sha256": sha256(f"{G}/qwen3-1.7b-pilot-s1-Q4_K_M.gguf")}
with open(f"{G}/SHA256SUMS", "w") as f:
    for r in STATUS["artifacts"].values():
        for k in ("F16", "Q4_K_M"):
            if k in r:
                f.write(f"{r[k]['sha256']}  {r[k]['file']}\n")
        if "file" in r:
            f.write(f"{r['sha256']}  {r['file']}\n")

# G1: template gates on the exported files ---------------------------------------------------------------------------
r = subprocess.run(f"cd {SRC} && LD_LIBRARY_PATH={L}/build/bin IRIS_LLAMA_SERVER={L}/build/bin/llama-server {sys.executable} {E1}/e1_gates.py --tokenizer {BASE} "
                   f"--gguf-r2 {G}/e1-r2-Q4_K_M.gguf --gguf-pilot {G}/qwen3-1.7b-pilot-s1-Q4_K_M.gguf --out {W}/gates.json",
                   shell=True, capture_output=True, text=True)
print(r.stdout[-2000:], r.stderr[-2000:], flush=True)
g = json.load(open(f"{W}/gates.json")) if os.path.exists(f"{W}/gates.json") else {}
STATUS["checks"]["G1_TG1"] = {"pass": bool(g.get("TG1_pass")), "matches": g.get("TG1_matches"), "n": g.get("n")}
STATUS["checks"]["G1_TG2"] = {"pass": bool(g.get("TG2_pass")), "hf": g.get("TG2_hf_matches"), "server": g.get("TG2_server_matches"), "n": g.get("n")}
STATUS["checks"]["TOK"] = {"r2": g.get("TOK_r2_matches"), "pilot": g.get("TOK_pilot_matches"), "n": g.get("n")}
STATUS["all_checks_pass"] = all(c.get("pass", True) for c in STATUS["checks"].values())
save()
log("done; all checks pass:", STATUS["all_checks_pass"], "deviations:", STATUS["deviations"])
