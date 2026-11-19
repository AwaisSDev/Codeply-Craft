"""CPU-only Kaggle kernel: compile llama.cpp (pinned commit) with CUDA for sm_75 (T4), without spending GPU quota.
Outputs /kaggle/working/llama-bin (binaries + shared libs) and every configure / build log, success or not."""
import os, subprocess, shutil, time
T0 = time.time(); W = "/kaggle/working"; L = f"{W}/logs"; os.makedirs(L, exist_ok=True)
COMMIT = "7a4117eef97ed6419241da2384b2b1c011ecd763"
def sh(cmd, log=None):
    print(f"[{time.time()-T0:6.0f}s] + {cmd[:250]}", flush=True)
    r = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    out = (r.stdout or "") + (r.stderr or "")
    if log: open(f"{L}/{log}", "w").write(out)
    print(out[-2500:], flush=True); return r
sh("nvcc --version; which nvcc; ls -d /usr/local/cuda*; nvidia-smi -L || true; cmake --version | head -1; gcc --version | head -1", "env.log")
sh(f"rm -rf /tmp/llama && mkdir /tmp/llama && cd /tmp/llama && git init -q && git remote add origin https://github.com/ggml-org/llama.cpp.git && git fetch -q --depth 1 origin {COMMIT} && git checkout -q FETCH_HEAD")
cfg = "-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=75 -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release"
r = sh(f"cd /tmp/llama && cmake -S . -B build {cfg}", "cmake.log")
if r.returncode:
    sh("cat /tmp/llama/build/CMakeFiles/CMakeError.log /tmp/llama/build/CMakeFiles/CMakeConfigureLog.yaml 2>/dev/null | tail -150", "cmake-errors.log")
    raise SystemExit("configure failed")
r = sh(f"cd /tmp/llama && cmake --build build -j{os.cpu_count()} --target llama-server llama-bench", "build.log")
if r.returncode: raise SystemExit("build failed")
shutil.copytree("/tmp/llama/build/bin", f"{W}/llama-bin")
sh(f"ls -la {W}/llama-bin; ldd {W}/llama-bin/llama-server | head -30", "ldd.log")
open(f"{W}/llama-bin/COMMIT", "w").write(COMMIT + "\n")
print("BUILD OK", round(time.time() - T0), "s", flush=True)
