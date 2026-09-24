#!/usr/bin/env bash
# Builds Cub3D for the browser (WebAssembly + pthreads) into web/dist/.
#
#   source /path/to/emsdk/emsdk_env.sh && ./web/build.sh
#   python3 web/dist/serve.py      # then open http://localhost:8000/
#
# The unmodified sources are linked against web/mlx, a MiniLibX
# implementation backed by an HTML canvas; the renderer thread pool and the
# physics thread run as real threads (Web Workers sharing wasm memory).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
OUT="${OUT:-$WEB/dist}"
OBJ="$ROOT/build/web"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

command -v emcc >/dev/null || { echo "emcc not found: source emsdk_env.sh first" >&2; exit 1; }

cd "$ROOT"
# Reuse the exact source lists of the native Makefiles.
SRCS=$(make --no-print-directory --eval='print-srcs: ; @echo $(SRCS)' print-srcs)
LIBFT_SRCS=$(make --no-print-directory -C lib/libft --eval='print-srcs: ; @echo $(SRCS)' print-srcs |
             tr ' ' '\n' | sed '/^$/d; s|^|lib/libft/|')

CFLAGS=(-O3 -std=gnu2x -D_GNU_SOURCE -DNDEBUG -pthread -Wall -Wextra -Wno-#warnings
        -Isrc -Ilib/libft -Iweb/mlx -Iweb/compat -include web/compat/glibc_compat.h)

OBJS=()
for src in $SRCS $LIBFT_SRCS web/mlx/mlx_web.c web/mlx/mlx_web_xpm.c; do
  o="$OBJ/${src%.c}.o"
  OBJS+=("$o")
  mkdir -p "$(dirname "$o")"
  emcc "${CFLAGS[@]}" -c "$src" -o "$o" &
  if (( $(jobs -rp | wc -l) >= JOBS )); then wait -n; fi
done
for pid in $(jobs -p); do wait "$pid"; done

mkdir -p "$OUT"
emcc -O3 -pthread "${OBJS[@]}" -o "$OUT/cub3D.js" \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE='navigator.hardwareConcurrency+2' \
  -sEXIT_RUNTIME -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=1GB \
  -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
  -sENVIRONMENT=web,worker -sEXPORTED_RUNTIME_METHODS=FS,callMain -sINVOKE_RUN=0 \
  --pre-js "$WEB/mlx/mlx_web.js" \
  --preload-file maps@/maps --preload-file textures@/textures -lm

ls maps | grep '\.cub$' | sed 's/\.cub$//' |
  python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))' > "$OUT/maps.json"
cp "$WEB/index.html" "$WEB/coi-serviceworker.js" "$WEB/serve.py" "$OUT/"
echo "Cub3D web build ready in $OUT"
