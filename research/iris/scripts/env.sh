# Local paths for this container; override when reproducing elsewhere.
export IRIS_WORK=${IRIS_WORK:-/home/user/iris-work}
export PY=${PY:-$IRIS_WORK/venv/bin/python}
export LLAMA=${LLAMA:-$IRIS_WORK/llama.cpp}
export IRIS_LLAMA_SERVER=$LLAMA/build/bin/llama-server
export LD_LIBRARY_PATH=$LLAMA/build/bin:${LD_LIBRARY_PATH:-}
export PYTHONPATH=$LLAMA/gguf-py:${PYTHONPATH:-}
export BASE=${BASE:-$IRIS_WORK/models/Qwen3-0.6B}
export BASE_GGUF=${BASE_GGUF:-$IRIS_WORK/gguf/qwen3-0.6b-base-Q8_0.gguf}
